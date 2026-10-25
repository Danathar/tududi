'use strict';

const entitlements = require('../../services/entitlementsService');
const { Op } = require('sequelize');
const projectsRepository = require('./repository');
const {
    validateUid,
    validateName,
    validateStatus,
    validatePriority,
    formatDate,
} = require('./validation');
const {
    NotFoundError,
    ValidationError,
    ForbiddenError,
} = require('../../shared/errors');
const { validateTagName } = require('../tags/tagsService');
const permissionsService = require('../../services/permissionsService');
const scopeService = require('../../services/scopeService');
const { isAreaOverridden } = require('../../services/projectAreaOverrides');
const { sortTags } = require('../tasks/core/serializers');
const { getBlockedCountMap } = require('../tasks/relations/service');
const {
    getSafeTimezone,
    processDueDateForResponse,
} = require('../../utils/timezone-utils');
const { uid: generateUid } = require('../../utils/uid');
const { extractUidFromSlug } = require('../../utils/slug-utils');
const { logError } = require('../../services/logService');
const {
    syncProjectSharesFromContainer,
    revokeProjectContainerShares,
} = require('../../services/containerShareSync');
const {
    validateAreaAccess,
    validateGoalAccess,
} = require('../tasks/utils/validation');
const { Project } = require('../../models');

const PROJECT_STATUSES = Project.rawAttributes.status.values;

// A project can only be filed under an area or goal the caller owns or can
// edit. Missing and inaccessible ids get the same error, so ids cannot be
// probed and another user's area or goal name never comes back in the
// response. Keeping the value the project already has is always allowed.
async function resolveContainerId(validate, value, userId, label, current) {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    if (
        current !== undefined &&
        current !== null &&
        `${value}` === `${current}`
    ) {
        return current;
    }
    try {
        return await validate(value, userId);
    } catch {
        throw new ValidationError(`Invalid ${label}.`);
    }
}
const MAX_REORDER_PROJECTS = 5000;

/**
 * Update project tags.
 */
async function updateProjectTags(project, tagsData, userId) {
    if (!tagsData) return;

    const validTagNames = [];
    const invalidTags = [];

    for (const tag of tagsData) {
        const validation = validateTagName(tag.name);
        if (validation.valid) {
            if (!validTagNames.includes(validation.name)) {
                validTagNames.push(validation.name);
            }
        } else {
            invalidTags.push({ name: tag.name, error: validation.error });
        }
    }

    if (invalidTags.length > 0) {
        throw new ValidationError(
            `Invalid tag names: ${invalidTags.map((t) => `"${t.name}" (${t.error})`).join(', ')}`
        );
    }

    if (validTagNames.length === 0) {
        await project.setTags([]);
        return;
    }

    const existingTags = await projectsRepository.findTagsByNames(
        userId,
        validTagNames
    );
    const existingTagNames = existingTags.map((tag) => tag.name);
    const newTagNames = validTagNames.filter(
        (name) => !existingTagNames.includes(name)
    );

    const createdTags = await Promise.all(
        newTagNames.map((name) => projectsRepository.createTag(name, userId))
    );

    await project.setTags([...existingTags, ...createdTags]);
}

/**
 * Calculate task status counts.
 */
function calculateTaskStatus(tasks) {
    const taskList = tasks || [];
    return {
        total: taskList.length,
        done: taskList.filter((t) => t.status === 2).length,
        in_progress: taskList.filter((t) => t.status === 1).length,
        not_started: taskList.filter((t) => t.status === 0).length,
    };
}

class ProjectsService {
    /**
     * Get all projects for a user with filters.
     */
    async getAll(userId, query) {
        const {
            status,
            state,
            active,
            pin_to_sidebar,
            area_id,
            grouped,
            project_uid,
            tags,
        } = query;
        const statusFilter = status || state;
        // area_uid is the Focus scope's spelling of the area filter
        const area = query.area || query.area_uid;

        // Resolve area filter target ID (used after applying per-user overrides)
        let areaFilterId = null;
        if (area && area !== '') {
            const uid = extractUidFromSlug(area);
            if (uid) {
                const areaRecord = await projectsRepository.findAreaByUid(uid);
                if (areaRecord) {
                    areaFilterId = areaRecord.id;
                }
            }
        } else if (area_id && area_id !== '') {
            areaFilterId = parseInt(area_id, 10) || area_id;
        }

        let whereClause = await permissionsService.ownershipOrPermissionWhere(
            'project',
            userId
        );

        // A Focus scope narrows the list to one project and/or projects
        // carrying every given tag. The area part keeps the override-aware
        // in-memory filter below.
        const scope = await scopeService.resolveScope(
            { project_uid, tags },
            userId
        );
        const scopeWhere = await scopeService.projectScopeWhere(scope);
        if (scopeWhere) {
            whereClause = scopeService.withScope(whereClause, scopeWhere);
        }

        if (statusFilter && statusFilter !== 'all') {
            // status is an ENUM column: PostgreSQL rejects unknown labels
            // outright, so validate before they reach the query.
            const statuses = Array.isArray(statusFilter)
                ? statusFilter
                : [statusFilter];
            const invalid = statuses.filter(
                (status) => !PROJECT_STATUSES.includes(status)
            );
            if (invalid.length > 0) {
                throw new ValidationError(
                    `Invalid project status filter: ${invalid.join(', ')}`
                );
            }
            whereClause.status = Array.isArray(statusFilter)
                ? { [Op.in]: statusFilter }
                : statusFilter;
        }

        if (active === 'true') {
            whereClause.status = {
                [Op.in]: ['planned', 'in_progress', 'waiting'],
            };
        } else if (active === 'false') {
            whereClause.status = { [Op.in]: ['not_started', 'done'] };
        }

        if (pin_to_sidebar === 'true') {
            whereClause.pin_to_sidebar = true;
        } else if (pin_to_sidebar === 'false') {
            whereClause.pin_to_sidebar = false;
        }

        // When filtering by area, owned projects can be filtered at the DB level.
        // Shared projects use per-user overrides, so we apply the area filter in-memory
        // after resolving overrides. We omit the DB-level area filter here and handle
        // it below to ensure shared projects' personal area placements are respected.

        const projects =
            await projectsRepository.findAllWithFilters(whereClause);

        const projectUids = projects.map((p) => p.uid).filter(Boolean);
        const shareCountMap =
            await projectsRepository.getShareCounts(projectUids);
        const sharedUids =
            await projectsRepository.getSharedProjectUids(projectUids);

        // Load per-user area overrides (covers shared projects assigned to user's areas)
        const areaOverrides =
            await projectsRepository.getUserProjectAreaOverrides(userId);
        const positions =
            await projectsRepository.getUserProjectPositions(userId);

        const enhancedProjects = projects
            .map((project) => {
                const taskStatus = calculateTaskStatus(project.Tasks);
                const projectJson = project.toJSON();
                const shareCount = shareCountMap[project.uid] || 0;

                // Apply per-user area override for shared (non-owned) projects
                const override = areaOverrides[project.id];
                if (isAreaOverridden(project.user_id, userId, override)) {
                    projectJson.area_id = override.area_id;
                    projectJson.Area = override.Area;
                }

                const isActiveStatus =
                    project.status === 'planned' ||
                    project.status === 'in_progress';
                const activeTaskCount =
                    taskStatus.in_progress + taskStatus.not_started;
                const isStalled = isActiveStatus && activeTaskCount === 0;

                return {
                    ...projectJson,
                    tags: sortTags(projectJson.Tags),
                    due_date_at: formatDate(project.due_date_at),
                    task_status: taskStatus,
                    completion_percentage:
                        taskStatus.total > 0
                            ? Math.round(
                                  (taskStatus.done / taskStatus.total) * 100
                              )
                            : 0,
                    user_uid: projectJson.User?.uid,
                    share_count: shareCount,
                    is_shared: sharedUids.has(project.uid),
                    is_stalled: isStalled,
                    sort_position: positions[project.id] ?? null,
                };
            })
            .filter((project) => {
                if (areaFilterId === null) return true;
                return project.area_id == areaFilterId;
            });

        if (grouped === 'true') {
            const groupedProjects = {};
            enhancedProjects.forEach((project) => {
                const areaName = project.Area ? project.Area.name : 'No Area';
                if (!groupedProjects[areaName]) {
                    groupedProjects[areaName] = [];
                }
                groupedProjects[areaName].push(project);
            });
            return groupedProjects;
        }

        return { projects: enhancedProjects };
    }

    /**
     * Save the user's custom order of the Projects page.
     */
    async reorder(userId, projectUids) {
        if (
            !Array.isArray(projectUids) ||
            projectUids.some((uid) => typeof uid !== 'string' || !uid)
        ) {
            throw new ValidationError('project_uids must be a list of UIDs.');
        }
        if (projectUids.length > MAX_REORDER_PROJECTS) {
            throw new ValidationError(
                `Cannot order more than ${MAX_REORDER_PROJECTS} projects.`
            );
        }
        if (new Set(projectUids).size !== projectUids.length) {
            throw new ValidationError('project_uids contains duplicates.');
        }

        const whereClause = await permissionsService.ownershipOrPermissionWhere(
            'project',
            userId
        );
        const projects = projectUids.length
            ? await projectsRepository.findIdsByUids(whereClause, projectUids)
            : [];
        if (projects.length !== projectUids.length) {
            throw new NotFoundError('One or more projects not found.');
        }

        const idByUid = new Map(projects.map((p) => [p.uid, p.id]));
        await projectsRepository.replaceUserProjectOrder(
            userId,
            projectUids.map((uid) => idByUid.get(uid))
        );
        return { project_uids: projectUids };
    }

    /**
     * Get project by UID.
     */
    async getByUid(uid, userTimezone) {
        const validatedUid = validateUid(uid);
        const project =
            await projectsRepository.findByUidWithIncludes(validatedUid);

        if (!project) {
            throw new NotFoundError('Project not found');
        }

        const safeTimezone = getSafeTimezone(userTimezone);
        const projectJson = project.toJSON();

        // Same blocked flags the task serializer adds, so the "Blocked" badge
        // on the project page comes from the server and survives a reload.
        const blockedCountMap = await getBlockedCountMap(
            (projectJson.Tasks || []).map((task) => task.id)
        );

        const normalizedTasks = projectJson.Tasks
            ? projectJson.Tasks.map((task) => {
                  const blockedByCount = blockedCountMap[task.id] || 0;
                  const normalizedTask = {
                      ...task,
                      blocked_by_count: blockedByCount,
                      is_blocked: blockedByCount > 0,
                      tags: sortTags(task.Tags),
                      subtasks: (task.Subtasks || []).map((subtask) => ({
                          ...subtask,
                          tags: sortTags(subtask.Tags),
                      })),
                      due_date: processDueDateForResponse(
                          task.due_date,
                          safeTimezone
                      ),
                  };
                  delete normalizedTask.Tags;
                  delete normalizedTask.Subtasks;
                  return normalizedTask;
              })
            : [];

        const normalizedNotes = projectJson.Notes
            ? projectJson.Notes.map((note) => {
                  const normalizedNote = { ...note, tags: sortTags(note.Tags) };
                  delete normalizedNote.Tags;
                  return normalizedNote;
              })
            : [];

        const shareCount = project.uid
            ? await projectsRepository.getShareCount(project.uid)
            : 0;
        const sharedUids = project.uid
            ? await projectsRepository.getSharedProjectUids([project.uid])
            : new Set();

        return {
            ...projectJson,
            tags: sortTags(projectJson.Tags),
            Tasks: normalizedTasks,
            Notes: normalizedNotes,
            due_date_at: formatDate(project.due_date_at),
            user_id: project.user_id,
            share_count: shareCount,
            is_shared: sharedUids.has(project.uid),
        };
    }

    /**
     * Check if project exists and return UID (for authorization).
     */
    async getProjectUidIfExists(uidOrSlug) {
        const uid = extractUidFromSlug(uidOrSlug);
        const project = await projectsRepository.findByUid(uid);
        return project ? project.uid : null;
    }

    /**
     * Create a new project.
     */
    async create(userId, data) {
        await entitlements.assertCanCreate(userId, 'project');
        const {
            name,
            description,
            area_id,
            goal_id,
            is_maintenance,
            priority,
            due_date_at,
            image_url,
            color,
            status,
            state,
            tags,
            Tags,
        } = data;

        const validatedName = validateName(name);
        const tagsData = tags || Tags;
        const projectUid = generateUid();
        const resolvedAreaId = await resolveContainerId(
            validateAreaAccess,
            area_id,
            userId,
            'area'
        );
        const resolvedGoalId = await resolveContainerId(
            validateGoalAccess,
            goal_id,
            userId,
            'goal'
        );

        const projectData = {
            uid: projectUid,
            name: validatedName,
            description: description || '',
            area_id: resolvedAreaId || null,
            goal_id: resolvedGoalId || null,
            is_maintenance: is_maintenance || false,
            pin_to_sidebar: false,
            priority: priority || null,
            due_date_at: due_date_at || null,
            image_url: image_url || null,
            color: color || null,
            status: status || state || 'not_started',
            user_id: userId,
        };

        const project = await projectsRepository.create(projectData);

        try {
            await updateProjectTags(project, tagsData, userId);
        } catch (tagError) {
            logError(
                'Tag update failed, but project created successfully:',
                tagError.message
            );
        }

        if (projectData.area_id || projectData.goal_id) {
            await syncProjectSharesFromContainer(project.id);
        }

        return {
            ...project.toJSON(),
            uid: projectUid,
            tags: [],
            due_date_at: formatDate(project.due_date_at),
        };
    }

    /**
     * Update a project.
     */
    async update(userId, uid, data) {
        const validatedUid = validateUid(uid);
        const project = await projectsRepository.findOne({ uid: validatedUid });

        if (!project) {
            throw new NotFoundError('Project not found.');
        }

        const isOwner = project.user_id === userId;

        const {
            name,
            description,
            area_id,
            goal_id,
            is_maintenance,
            pin_to_sidebar,
            priority,
            due_date_at,
            image_url,
            color,
            status,
            state,
            tags,
            Tags,
        } = data;

        const tagsData = tags || Tags;
        const updateData = {};

        if (name !== undefined) updateData.name = validateName(name);
        if (description !== undefined) updateData.description = description;
        if (goal_id !== undefined) {
            const resolvedGoalId = await resolveContainerId(
                validateGoalAccess,
                goal_id,
                userId,
                'goal',
                project.goal_id
            );
            if (isOwner) {
                updateData.goal_id = resolvedGoalId;
            } else if (
                `${resolvedGoalId ?? ''}` !== `${project.goal_id ?? ''}`
            ) {
                // The goal is shared state for every collaborator, so only
                // the owner can change it. Re-sending the current goal (the
                // form does on every save) is a no-op.
                throw new ForbiddenError(
                    'Only the project owner can change its goal.'
                );
            }
        }
        if (is_maintenance !== undefined)
            updateData.is_maintenance = is_maintenance;
        if (pin_to_sidebar !== undefined)
            updateData.pin_to_sidebar = pin_to_sidebar;
        if (priority !== undefined)
            updateData.priority = validatePriority(priority);
        if (due_date_at !== undefined)
            updateData.due_date_at = due_date_at === '' ? null : due_date_at;
        if (image_url !== undefined)
            updateData.image_url = image_url === '' ? null : image_url;
        if (color !== undefined) updateData.color = color === '' ? null : color;
        if (status !== undefined)
            updateData.status = validateStatus(status, PROJECT_STATUSES);
        else if (state !== undefined)
            updateData.status = validateStatus(state, PROJECT_STATUSES);

        if (area_id !== undefined) {
            const resolvedAreaId = await resolveContainerId(
                validateAreaAccess,
                area_id,
                userId,
                'area',
                project.area_id
            );
            if (isOwner) {
                // Owner controls the canonical area for all users
                updateData.area_id = resolvedAreaId;
            } else {
                // Non-owners store their personal area placement without touching the project
                await projectsRepository.upsertUserProjectArea(
                    userId,
                    project.id,
                    resolvedAreaId
                );
            }
        }

        // The area and goal the project is leaving, if any.
        const leftContainer = {
            area_id:
                updateData.area_id !== undefined &&
                `${updateData.area_id}` !== `${project.area_id}`
                    ? project.area_id
                    : null,
            goal_id:
                updateData.goal_id !== undefined &&
                `${updateData.goal_id}` !== `${project.goal_id}`
                    ? project.goal_id
                    : null,
        };

        await projectsRepository.update(project, updateData);
        // Tags belong to the project's owner, so a collaborator's edit
        // resolves names in the owner's tag list instead of swapping the
        // owner's tags for the collaborator's own.
        await updateProjectTags(project, tagsData, project.user_id);

        // Moving the project out of a shared area or goal takes away the
        // access that container's collaborators had to it; moving it into
        // one mirrors that container's collaborators onto the project.
        if (leftContainer.area_id || leftContainer.goal_id) {
            await revokeProjectContainerShares(project.id, leftContainer);
        }
        if (
            isOwner &&
            (updateData.area_id !== undefined ||
                updateData.goal_id !== undefined)
        ) {
            await syncProjectSharesFromContainer(project.id);
        }

        const projectWithAssociations =
            await projectsRepository.findByUidWithTagsAndArea(validatedUid);
        const projectJson = projectWithAssociations.toJSON();

        return {
            ...projectJson,
            tags: sortTags(projectJson.Tags),
            due_date_at: formatDate(projectWithAssociations.due_date_at),
        };
    }

    // Marks a project done, optionally finishing its open tasks too.
    async complete(userId, uid, { completeOpenTasks = false } = {}) {
        const validatedUid = validateUid(uid);
        const project = await projectsRepository.findOne({ uid: validatedUid });

        if (!project) {
            throw new NotFoundError('Project not found.');
        }

        let completedTasks = 0;
        if (completeOpenTasks) {
            const openTasks = await projectsRepository.findOpenTasks(
                project.id
            );
            // One by one so task hooks (webhooks, history) still run
            for (const task of openTasks) {
                await task.update({ status: 2, completed_at: new Date() });
            }
            completedTasks = openTasks.length;
        }

        const updated = await this.update(userId, validatedUid, {
            status: 'done',
        });
        return { project: updated, completed_tasks: completedTasks };
    }

    /**
     * Delete a project.
     */
    async delete(userId, uid) {
        const validatedUid = validateUid(uid);
        const project = await projectsRepository.findOne({ uid: validatedUid });

        if (!project) {
            throw new NotFoundError('Project not found.');
        }

        await projectsRepository.deleteWithOrphaning(project, userId);
        return { message: 'Project successfully deleted' };
    }
}

module.exports = new ProjectsService();
module.exports.updateProjectTags = updateProjectTags;
