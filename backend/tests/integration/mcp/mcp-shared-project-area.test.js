'use strict';

const request = require('supertest');
const app = require('../../../app');
const { Area, Project, Task, UserProjectArea } = require('../../../models');
const {
    createTestUser,
    acceptAllInvitations,
} = require('../../helpers/testUtils');
const {
    createApiToken: createApiTokenFromService,
} = require('../../../modules/users/apiTokenService');

function parseSseResponse(text) {
    for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) {
            try {
                return JSON.parse(line.slice(6));
            } catch {
                continue;
            }
        }
    }
    return null;
}

function getToolContent(response) {
    const rpc = parseSseResponse(response.text);
    if (!rpc || !rpc.result) {
        throw new Error(
            `Unexpected MCP response: ${response.text.slice(0, 200)}`
        );
    }
    expect(rpc.result.isError).not.toBe(true);
    return JSON.parse(rpc.result.content[0].text);
}

// Someone a project is shared with can place it in one of their own areas.
// The MCP tools must show that placement to them, as the web app does, and
// the owner's placement to the owner.
describe('MCP: area of a shared project', () => {
    let owner, viewer, ownerToken, viewerToken;
    let ownerArea, viewerArea, project, task;

    const login = async (email) => {
        const agent = request.agent(app);
        await agent.post('/api/login').send({ email, password: 'password123' });
        return agent;
    };

    const tokenFor = async (userId) =>
        (
            await createApiTokenFromService({
                userId,
                name: 'MCP shared area test',
                expiresAt: null,
            })
        ).rawToken;

    const callTool = async (token, name, args = {}) =>
        getToolContent(
            await request(app)
                .post('/api/mcp')
                .set('Authorization', `Bearer ${token}`)
                .set('Content-Type', 'application/json')
                .set('Accept', 'application/json, text/event-stream')
                .send({
                    jsonrpc: '2.0',
                    method: 'tools/call',
                    params: { name, arguments: args },
                    id: 1,
                })
        );

    beforeEach(async () => {
        owner = await createTestUser({
            email: 'mcp-area-owner@example.com',
            timezone: 'UTC',
        });
        viewer = await createTestUser({
            email: 'mcp-area-viewer@example.com',
            timezone: 'UTC',
        });
        const ownerAgent = await login('mcp-area-owner@example.com');
        const viewerAgent = await login('mcp-area-viewer@example.com');

        ownerArea = await Area.create({ name: 'Work', user_id: owner.id });
        viewerArea = await Area.create({ name: 'My side', user_id: viewer.id });
        project = await Project.create({
            name: 'Shared plan',
            user_id: owner.id,
            area_id: ownerArea.id,
        });
        task = await Task.create({
            name: 'Shared task',
            user_id: owner.id,
            project_id: project.id,
        });

        await ownerAgent.post('/api/shares').send({
            resource_type: 'project',
            resource_uid: project.uid,
            target_user_email: viewer.email,
            access_level: 'rw',
        });
        await acceptAllInvitations(viewerAgent);

        await UserProjectArea.create({
            user_id: viewer.id,
            project_id: project.id,
            area_id: viewerArea.id,
        });

        ownerToken = await tokenFor(owner.id);
        viewerToken = await tokenFor(viewer.id);
    });

    it('shows the viewer their own placement in list_tasks and get_task', async () => {
        const list = await callTool(viewerToken, 'list_tasks', {
            project_id: project.id,
        });
        const listed = list.tasks.find((t) => t.uid === task.uid);
        expect(listed).toBeDefined();
        expect(listed.Project.area_id).toBe(viewerArea.id);

        const single = await callTool(viewerToken, 'get_task', {
            id: task.uid,
        });
        expect(single.Project.area_id).toBe(viewerArea.id);
        expect(single.Project.Area.uid).toBe(viewerArea.uid);
    });

    it('shows the viewer their own placement on a task they create or update', async () => {
        const created = await callTool(viewerToken, 'create_task', {
            name: 'Viewer added task',
            project_uid: project.uid,
        });
        expect(created.task.Project.area_id).toBe(viewerArea.id);

        const updated = await callTool(viewerToken, 'update_task', {
            id: task.uid,
            name: 'Renamed shared task',
        });
        expect(updated.task.Project.area_id).toBe(viewerArea.id);
    });

    it("keeps the owner's own area for the owner's task tools", async () => {
        const single = await callTool(ownerToken, 'get_task', {
            id: task.uid,
        });
        expect(single.Project.area_id).toBe(ownerArea.id);
    });

    it('lists the shared project under the area the viewer placed it in', async () => {
        const inViewerArea = await callTool(viewerToken, 'list_projects', {
            area_id: viewerArea.id,
        });
        const listed = inViewerArea.projects.find((p) => p.uid === project.uid);
        expect(listed).toBeDefined();
        expect(listed.area).toBe('My side');

        const inOwnerArea = await callTool(viewerToken, 'list_projects', {
            area_id: ownerArea.id,
        });
        const elsewhere = inOwnerArea.projects.map((p) => p.uid);
        expect(elsewhere).not.toContain(project.uid);

        const all = await callTool(viewerToken, 'list_projects');
        const unfiltered = all.projects.find((p) => p.uid === project.uid);
        expect(unfiltered.area).toBe('My side');

        const single = await callTool(viewerToken, 'get_project', {
            uid: project.uid,
        });
        expect(single.project.area).toBe('My side');
    });

    it("keeps the owner's own area for the owner's project tools", async () => {
        const inOwnerArea = await callTool(ownerToken, 'list_projects', {
            area_id: ownerArea.id,
        });
        const listed = inOwnerArea.projects.find((p) => p.uid === project.uid);
        expect(listed).toBeDefined();
        expect(listed.area).toBe('Work');

        const single = await callTool(ownerToken, 'get_project', {
            uid: project.uid,
        });
        expect(single.project.area).toBe('Work');
    });
});
