const { Task, TaskEvent, TaskAttachment, sequelize } = require('../../../models');
const taskRepository = require('../repository');
const { deleteAttachmentFiles } = require('../../../utils/attachment-utils');
const { withForeignKeyChecksDisabled } = require('../../../utils/db-dialect');
const { logError } = require('../../../services/logService');

// The one way to delete a task. The REST route, the MCP delete_task tool and
// the CalDAV DELETE handler all call it, so every path does the same cleanup.

// All subtasks below the task, at any depth, deepest first. `seen` guards
// against a parent_task_id cycle left behind by older data.
async function collectSubtasks(taskId) {
    const levels = [];
    const seen = new Set([taskId]);
    let frontier = [taskId];

    while (frontier.length > 0) {
        const children = await Task.findAll({
            where: { parent_task_id: frontier },
        });
        const level = children.filter((child) => !seen.has(child.id));
        level.forEach((child) => seen.add(child.id));
        if (level.length > 0) levels.push(level);
        frontier = level.map((child) => child.id);
    }

    return levels.reverse().flat();
}

// Future instances of a recurring task go with it; past ones stay as plain
// standalone tasks, so the history of what was done survives.
async function deleteOrDetachRecurringChildren(taskId) {
    const childTasks = await taskRepository.findRecurringChildren(taskId);
    if (childTasks.length === 0) return;

    const now = new Date();

    for (const child of childTasks) {
        const isFuture = !child.due_date || new Date(child.due_date) > now;
        if (isFuture) {
            await child.destroy();
        } else {
            await child.update({
                recurring_parent_id: null,
                recurrence_type: 'none',
                recurrence_interval: null,
                recurrence_end_date: null,
                recurrence_weekday: null,
                recurrence_month_day: null,
                recurrence_week_of_month: null,
                completion_based: false,
            });
        }
    }
}

// Before the row goes away, so the remote copy does not survive to be pulled
// back in as a new task on the next sync (#1371). Required lazily because the
// CalDAV module already depends on this one.
async function deleteFromCaldavRemotes(task) {
    try {
        const {
            deleteTaskFromRemotes,
        } = require('../../caldav/services/task-deletion-service');
        await deleteTaskFromRemotes(task);
    } catch (error) {
        logError('Error removing task from CalDAV remotes:', error);
    }
}

// Dependent rows are removed in dependency order, which is what PostgreSQL
// relies on; older SQLite databases additionally get constraint checks
// switched off by the caller.
async function destroyTaskRows(task) {
    const taskId = task.id;

    await TaskEvent.destroy({ where: { task_id: taskId }, force: true });

    await sequelize.query('DELETE FROM tasks_tags WHERE task_id = ?', {
        replacements: [taskId],
    });

    await sequelize.query(
        'DELETE FROM task_relations WHERE source_task_id = ? OR target_task_id = ?',
        { replacements: [taskId, taskId] }
    );

    await sequelize.query('DELETE FROM user_task_orders WHERE task_id = ?', {
        replacements: [taskId],
    });

    await taskRepository.clearRecurringParent(taskId);

    // Unlink attachment files from disk before destroying rows, so a
    // dangling file never outlives the record that gated its access
    // (GHSA-43p8-ch4p-gqg4).
    const attachments = await TaskAttachment.findAll({
        where: { task_id: taskId },
    });
    await deleteAttachmentFiles(attachments);
    await TaskAttachment.destroy({ where: { task_id: taskId }, force: true });

    await task.destroy({ force: true });
}

// Deletes the task and its subtasks (docs/00-tasks-behavior.md: "Deleting the
// parent deletes all subtasks"), with their events, tags, relations, orders,
// attachments and remote CalDAV copies.
async function deleteTask(task) {
    const subtasks = await collectSubtasks(task.id);
    const tasks = [...subtasks, task];

    for (const each of tasks) {
        await deleteOrDetachRecurringChildren(each.id);
    }

    for (const each of tasks) {
        await deleteFromCaldavRemotes(each);
    }

    await withForeignKeyChecksDisabled(sequelize, async () => {
        for (const each of tasks) {
            await destroyTaskRows(each);
        }
    });
}

module.exports = {
    deleteTask,
};
