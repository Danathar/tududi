'use strict';

const { registerTaskTools } = require('./tools/taskTools');
const { registerCommentTools } = require('./tools/commentTools');
const { registerProjectTools } = require('./tools/projectTools');
const { registerInboxTools } = require('./tools/inboxTools');
const { registerMiscTools } = require('./tools/miscTools');
const { registerHabitTools } = require('./tools/habitTools');
const { registerAreaTools } = require('./tools/areaTools');
const { registerTagTools } = require('./tools/tagTools');
const { registerNoteTools } = require('./tools/noteTools');
const { registerViewTools } = require('./tools/viewTools');
const { registerPeopleTools } = require('./tools/peopleTools');
const { registerGoalTools } = require('./tools/goalTools');
const { validateToolArguments } = require('./argumentValidation');

// Registration order; the category is the name Profile > MCP lists the tools
// under.
const REGISTRARS = [
    ['Tasks', registerTaskTools],
    ['Comments', registerCommentTools],
    ['Projects', registerProjectTools],
    ['Inbox', registerInboxTools],
    ['Misc', registerMiscTools],
    ['Habits', registerHabitTools],
    ['Areas', registerAreaTools],
    ['Tags', registerTagTools],
    ['Notes', registerNoteTools],
    ['Views', registerViewTools],
    ['People', registerPeopleTools],
    ['Goals', registerGoalTools],
];

// Every call is checked against the tool's inputSchema before its handler
// runs, so the tools do not each have to repeat the check.
const validated = new WeakSet();

function withArgumentValidation(tool) {
    if (validated.has(tool)) return;
    validated.add(tool);
    const handler = tool.handler;
    tool.handler = async (params, ...rest) => {
        validateToolArguments(tool, params);
        return handler(params, ...rest);
    };
}

function registerAllTools(server, context, tools) {
    for (const [, register] of REGISTRARS) {
        register(server, context, tools);
    }
    tools.forEach(withArgumentValidation);
}

// The tool names per category, taken from the registrars themselves so the
// list cannot drift from what the server actually offers.
function listToolCategories() {
    return REGISTRARS.map(([category, register]) => {
        const tools = [];
        register(null, {}, tools);
        const names = tools.map((tool) => tool.name);
        return { category, count: names.length, tools: names };
    });
}

module.exports = { registerAllTools, listToolCategories };
