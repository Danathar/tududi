'use strict';

const { Op } = require('sequelize');
const {
    sequelize,
    Permission,
    GroupPermission,
    GroupShare,
    Action,
    Area,
    Goal,
    Project,
    Task,
    Note,
} = require('../models');
const { applyPerms } = require('./applyPerms');
const {
    projectSubtreeChanges,
    collectProjectDescendants,
    collectTaskSubtree,
} = require('./permissionsCalculators');
const { mirrorContainerGrants } = require('./groupSharing');
const { logError } = require('./logService');

async function findContainers(tx, project) {
    const containers = [];

    if (project.area_id) {
        const area = await Area.findByPk(project.area_id, {
            attributes: ['uid'],
            transaction: tx,
        });
        if (area) containers.push({ type: 'area', uid: area.uid });
    }

    if (project.goal_id) {
        const goal = await Goal.findByPk(project.goal_id, {
            attributes: ['uid'],
            transaction: tx,
        });
        if (goal) containers.push({ type: 'goal', uid: goal.uid });
    }

    return containers;
}

async function mirrorDirectShares(tx, project, containers) {
    const containerPerms = [];
    for (const container of containers) {
        containerPerms.push(
            ...(await Permission.findAll({
                where: {
                    resource_type: container.type,
                    resource_uid: container.uid,
                },
                transaction: tx,
                raw: true,
            }))
        );
    }

    if (containerPerms.length === 0) return;

    // One grant per target user: highest access wins, an accepted grant
    // beats a pending one.
    const byUser = new Map();
    for (const perm of containerPerms) {
        if (perm.user_id === project.user_id) continue;
        const current = byUser.get(perm.user_id);
        if (!current) {
            byUser.set(perm.user_id, perm);
            continue;
        }
        const better =
            (perm.access_level === 'rw' && current.access_level !== 'rw') ||
            (perm.status === 'accepted' && current.status !== 'accepted');
        if (better) byUser.set(perm.user_id, perm);
    }

    const changes = { upserts: [], deletes: [] };
    for (const perm of byUser.values()) {
        const before = changes.upserts.length;
        await projectSubtreeChanges(
            changes,
            {
                id: project.id,
                uid: project.uid,
                user_id: project.user_id,
            },
            {
                verb: 'share_grant',
                targetUserId: perm.user_id,
                actorUserId: perm.granted_by_user_id || project.user_id,
                accessLevel: perm.access_level,
            },
            'inherited'
        );
        for (let i = before; i < changes.upserts.length; i++) {
            changes.upserts[i].status = perm.status;
            changes.upserts[i].sourceActionId = perm.source_action_id;
        }
    }

    await applyPerms(tx, changes);
}

// When a project is created in (or moved into) a shared area or goal, mirror
// that container's shares onto the project and its task/note subtree, so a
// collaborator does not have to be re-invited for every new project. Rows are
// written with the same status and source_action_id as the container grant, so
// a still-pending invite does not leak the new project early and accepting or
// declining still moves the whole set together. Group grants on the container
// are mirrored the same way into group_permissions.
async function syncProjectSharesFromContainer(projectId) {
    try {
        await sequelize.transaction(async (tx) => {
            const project = await Project.findByPk(projectId, {
                attributes: ['id', 'uid', 'user_id', 'area_id', 'goal_id'],
                transaction: tx,
            });
            if (!project) return;

            const containers = await findContainers(tx, project);
            if (containers.length === 0) return;

            await mirrorDirectShares(tx, project, containers);
            await mirrorContainerGrants(tx, project, containers);
        });
    } catch (error) {
        // A failed mirror must not fail the project write; the owner can
        // re-share the container to reconcile.
        logError(error, `Failed to sync project shares (project ${projectId})`);
    }
}

// Deletes the inherited rows on `items` that were cascaded from a share on one
// of `sources` (the containers the items just left). Direct grants, and rows
// cascaded from a share the items still sit under (a parent task's share, for
// example), are left alone. A direct row's source is its Action; a group row's
// source is its GroupShare.
async function pruneInheritedRows(tx, sources, items) {
    if (sources.length === 0) return;

    const uidsByType = {};
    for (const item of items) {
        (uidsByType[item.type] ||= []).push(item.uid);
    }
    const itemConditions = Object.entries(uidsByType).map(([type, uids]) => ({
        resource_type: type,
        resource_uid: { [Op.in]: uids },
    }));
    if (itemConditions.length === 0) return;

    const sourceWhere = {
        [Op.or]: sources.map((s) => ({
            resource_type: s.type,
            resource_uid: s.uid,
        })),
    };

    const actions = await Action.findAll({
        where: sourceWhere,
        attributes: ['id'],
        raw: true,
        transaction: tx,
    });
    if (actions.length > 0) {
        await Permission.destroy({
            where: {
                propagation: 'inherited',
                source_action_id: { [Op.in]: actions.map((a) => a.id) },
                [Op.or]: itemConditions,
            },
            transaction: tx,
        });
    }

    const shares = await GroupShare.findAll({
        where: sourceWhere,
        attributes: ['id'],
        raw: true,
        transaction: tx,
    });
    if (shares.length > 0) {
        await GroupPermission.destroy({
            where: {
                propagation: 'inherited',
                group_share_id: { [Op.in]: shares.map((s) => s.id) },
                [Op.or]: itemConditions,
            },
            transaction: tx,
        });
    }
}

// A project left an area and/or goal (`oldContainer` holds the area_id and
// goal_id it left; null for one it did not leave). Drops the access that the
// old container's sharees had to the project and everything in it. Call
// syncProjectSharesFromContainer afterwards to mirror the new container.
async function revokeProjectContainerShares(projectId, oldContainer) {
    await sequelize.transaction(async (tx) => {
        const project = await Project.findByPk(projectId, {
            attributes: ['id', 'uid'],
            transaction: tx,
        });
        if (!project) return;

        const sources = await findContainers(tx, oldContainer);
        if (sources.length === 0) return;

        const { taskUids, noteUids } = await collectProjectDescendants(
            project.id
        );
        await pruneInheritedRows(tx, sources, [
            { type: 'project', uid: project.uid },
            ...taskUids.map((uid) => ({ type: 'task', uid })),
            ...noteUids.map((uid) => ({ type: 'note', uid })),
        ]);
    });
}

// A task or note left a project. Drops the access that came from sharing that
// project, or the area or goal it sits in. Access through the new project
// needs no rows: it is derived from the item's project_id.
async function revokeProjectSharesForItem(itemType, itemId, oldProjectId) {
    if (!oldProjectId) return;
    await sequelize.transaction(async (tx) => {
        const oldProject = await Project.findByPk(oldProjectId, {
            attributes: ['uid', 'area_id', 'goal_id'],
            transaction: tx,
        });
        if (!oldProject) return;
        const sources = [
            { type: 'project', uid: oldProject.uid },
            ...(await findContainers(tx, oldProject)),
        ];

        let items;
        if (itemType === 'task') {
            const task = await Task.findByPk(itemId, {
                attributes: ['id', 'uid'],
                transaction: tx,
            });
            if (!task) return;
            const taskUids = await collectTaskSubtree(task.id, task.uid);
            items = taskUids.map((uid) => ({ type: 'task', uid }));
        } else {
            const note = await Note.findByPk(itemId, {
                attributes: ['uid'],
                transaction: tx,
            });
            if (!note) return;
            items = [{ type: 'note', uid: note.uid }];
        }

        await pruneInheritedRows(tx, sources, items);
    });
}

module.exports = {
    syncProjectSharesFromContainer,
    revokeProjectContainerShares,
    revokeProjectSharesForItem,
};
