'use strict';

// A project's area as one viewer sees it. The owner's placement is
// Project.area_id. Someone the project is shared with can place it in one of
// their own areas (a UserProjectArea row), and for them that placement wins.

const { Op } = require('sequelize');
const { Area, Project, UserProjectArea } = require('../models');

// True when the viewer's own placement replaces the owner's area: the viewer
// does not own the project and has placed it somewhere.
function isAreaOverridden(ownerId, viewerId, override) {
    return ownerId !== viewerId && override !== undefined;
}

// Rewrites task.Project.area_id / task.Project.Area on serialized tasks to the
// viewer's placement, for projects the viewer does not own. Mutates and
// returns the given tasks.
async function applyViewerProjectAreas(tasks, viewerId) {
    const projectIds = new Set();
    tasks.forEach((task) => {
        if (task?.Project?.id != null) projectIds.add(task.Project.id);
    });
    if (projectIds.size === 0) return tasks;

    const rows = await UserProjectArea.findAll({
        where: { user_id: viewerId, project_id: { [Op.in]: [...projectIds] } },
        include: [
            {
                model: Area,
                as: 'Area',
                required: false,
                attributes: ['id', 'uid', 'name', 'color'],
            },
        ],
    });
    if (rows.length === 0) return tasks;

    const owners = await Project.findAll({
        where: { id: { [Op.in]: rows.map((row) => row.project_id) } },
        attributes: ['id', 'user_id'],
        raw: true,
    });
    const ownerById = new Map(owners.map((p) => [p.id, p.user_id]));
    const overrideByProject = new Map(
        rows.map((row) => [
            row.project_id,
            {
                area_id: row.area_id,
                Area: row.Area ? row.Area.toJSON() : null,
            },
        ])
    );

    tasks.forEach((task) => {
        const project = task?.Project;
        if (!project) return;
        const override = overrideByProject.get(project.id);
        if (!isAreaOverridden(ownerById.get(project.id), viewerId, override)) {
            return;
        }
        task.Project = {
            ...project,
            area_id: override.area_id,
            Area: override.Area,
        };
    });
    return tasks;
}

// Rewrites area_id / Area on plain project objects (with id and user_id) to
// the viewer's placement, for projects the viewer does not own. Mutates and
// returns the given projects.
async function applyViewerAreasToProjects(projects, viewerId) {
    const sharedIds = projects
        .filter((project) => project && project.user_id !== viewerId)
        .map((project) => project.id);
    if (sharedIds.length === 0) return projects;

    const rows = await UserProjectArea.findAll({
        where: { user_id: viewerId, project_id: { [Op.in]: sharedIds } },
        include: [
            {
                model: Area,
                as: 'Area',
                required: false,
                attributes: ['id', 'uid', 'name', 'color'],
            },
        ],
    });
    const overrideByProject = new Map(
        rows.map((row) => [
            row.project_id,
            {
                area_id: row.area_id,
                Area: row.Area ? row.Area.toJSON() : null,
            },
        ])
    );

    projects.forEach((project) => {
        if (!project) return;
        const override = overrideByProject.get(project.id);
        if (!isAreaOverridden(project.user_id, viewerId, override)) return;
        project.area_id = override.area_id;
        project.Area = override.Area;
    });
    return projects;
}

module.exports = {
    isAreaOverridden,
    applyViewerProjectAreas,
    applyViewerAreasToProjects,
};
