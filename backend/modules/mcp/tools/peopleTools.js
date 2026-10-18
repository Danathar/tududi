'use strict';

const peopleRepository = require('../../people/repository');
const peopleService = require('../../people/service');
const rolesService = require('../../../services/rolesService');

function registerPeopleTools(server, context, tools) {
    // 1. list_people - List people/contacts
    tools.push({
        name: 'list_people',
        description: 'List people (contacts) with optional filtering',
        inputSchema: {
            type: 'object',
            properties: {
                archived: {
                    type: 'boolean',
                    description: 'Include archived contacts (default: false)',
                    default: false,
                },
                relationship_type: {
                    type: 'string',
                    description:
                        'Filter by relationship type (e.g. colleague, friend, family, other)',
                },
                sort: {
                    type: 'string',
                    enum: ['name', 'created_at'],
                    description: 'Sort order (default: name)',
                    default: 'name',
                },
            },
        },
        handler: async (params) => {
            const people = await peopleRepository.findAllByUser(
                context.userId,
                {
                    archived: params.archived || false,
                    sort: params.sort || 'name',
                    relationship_type: params.relationship_type,
                }
            );

            const serialized = people.map((p) => ({
                id: p.id,
                uid: p.uid,
                name: p.name,
                email: p.email,
                phone: p.phone,
                relationship_type: p.relationship_type,
                notes: p.notes,
                archived: p.archived,
                color: p.color,
                created_at: p.created_at,
                updated_at: p.updated_at,
            }));

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            { count: serialized.length, people: serialized },
                            null,
                            2
                        ),
                    },
                ],
            };
        },
    });

    // 2. get_person - Get a single person by UID
    tools.push({
        name: 'get_person',
        description: 'Get a specific person/contact by their UID',
        inputSchema: {
            type: 'object',
            properties: {
                uid: {
                    type: 'string',
                    description: 'Person UID',
                },
            },
            required: ['uid'],
        },
        handler: async (params) => {
            const person = await peopleRepository.findByUid(
                context.userId,
                params.uid
            );

            if (!person) {
                throw new Error(`Person not found: ${params.uid}`);
            }

            const assignedTaskCount = await peopleRepository.countAssignedTasks(
                person.uid
            );

            const serialized = {
                id: person.id,
                uid: person.uid,
                name: person.name,
                email: person.email,
                phone: person.phone,
                relationship_type: person.relationship_type,
                notes: person.notes,
                archived: person.archived,
                color: person.color,
                assigned_task_count: assignedTaskCount,
                created_at: person.created_at,
                updated_at: person.updated_at,
            };

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ person: serialized }, null, 2),
                    },
                ],
            };
        },
    });

    // 3. create_person - Create a new person/contact
    tools.push({
        name: 'create_person',
        description: 'Create a new person/contact',
        inputSchema: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Full name (required)',
                },
                email: {
                    type: 'string',
                    description: 'Email address',
                },
                phone: {
                    type: 'string',
                    description: 'Phone number',
                },
                relationship_type: {
                    type: 'string',
                    enum: peopleService.VALID_RELATIONSHIP_TYPES,
                    description:
                        'Relationship type: family, work, friend or other (default: other)',
                },
                notes: {
                    type: 'string',
                    description: 'Free-text notes about this person',
                },
                color: {
                    type: 'string',
                    description:
                        'Hex color for visual identification (e.g. #ff6b6b)',
                },
            },
            required: ['name'],
        },
        handler: async (params) => {
            await rolesService.assertCan(context.userId, 'create_people');

            // Same checks as POST /api/people: name, relationship type and
            // duplicate names
            const person = await peopleService.create(context.userId, {
                name: params.name,
                email: params.email,
                phone: params.phone,
                relationship_type: params.relationship_type,
                notes: params.notes,
                color: params.color,
            });

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            {
                                message: 'Person created successfully',
                                person: {
                                    id: person.id,
                                    uid: person.uid,
                                    name: person.name,
                                    email: person.email,
                                    phone: person.phone,
                                    relationship_type: person.relationship_type,
                                    created_at: person.created_at,
                                },
                            },
                            null,
                            2
                        ),
                    },
                ],
            };
        },
    });

    // 4. update_person - Update an existing person/contact
    tools.push({
        name: 'update_person',
        description: 'Update an existing person/contact',
        inputSchema: {
            type: 'object',
            properties: {
                uid: {
                    type: 'string',
                    description: 'Person UID (required)',
                },
                name: {
                    type: 'string',
                    description: 'New name',
                },
                email: {
                    type: 'string',
                    description: 'New email address',
                },
                phone: {
                    type: 'string',
                    description: 'New phone number',
                },
                relationship_type: {
                    type: 'string',
                    enum: peopleService.VALID_RELATIONSHIP_TYPES,
                    description:
                        'New relationship type: family, work, friend or other',
                },
                notes: {
                    type: 'string',
                    description: 'New notes',
                },
                color: {
                    type: 'string',
                    description: 'New hex color or empty string to remove',
                },
                archived: {
                    type: 'boolean',
                    description: 'Archive or unarchive this person',
                },
            },
            required: ['uid'],
        },
        handler: async (params) => {
            // Same checks as PATCH /api/people/:uid: name, relationship type
            // and duplicate names
            const person = await peopleService.update(
                context.userId,
                params.uid,
                {
                    name: params.name,
                    email: params.email,
                    phone: params.phone,
                    relationship_type: params.relationship_type,
                    notes: params.notes,
                    color: params.color,
                    archived: params.archived,
                }
            );

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            {
                                message: 'Person updated successfully',
                                person: {
                                    id: person.id,
                                    uid: person.uid,
                                    name: person.name,
                                    updated_at: person.updated_at,
                                },
                            },
                            null,
                            2
                        ),
                    },
                ],
            };
        },
    });

    // 5. delete_person - Delete a person/contact
    tools.push({
        name: 'delete_person',
        description: 'Delete a person/contact permanently',
        inputSchema: {
            type: 'object',
            properties: {
                uid: {
                    type: 'string',
                    description: 'Person UID',
                },
            },
            required: ['uid'],
        },
        handler: async (params) => {
            // Refuses the person standing for the user's own account and
            // people tasks are still assigned to, as DELETE /api/people/:uid
            await peopleService.delete(context.userId, params.uid);

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            { message: 'Person deleted successfully' },
                            null,
                            2
                        ),
                    },
                ],
            };
        },
    });
}

module.exports = { registerPeopleTools };
