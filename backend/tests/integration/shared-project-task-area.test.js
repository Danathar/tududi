'use strict';

const request = require('supertest');
const app = require('../../app');
const { Area, Project, Task, UserProjectArea } = require('../../models');
const {
    createTestUser,
    acceptAllInvitations,
} = require('../helpers/testUtils');

// Someone a project is shared with can place it in one of their own areas.
// Task responses must show that placement to them, and the owner's
// placement to the owner.
describe('Area of a shared project in task responses', () => {
    let owner, ownerAgent, viewerAgent, ownerArea, viewerArea, task;

    const login = async (email) => {
        const agent = request.agent(app);
        await agent.post('/api/login').send({ email, password: 'password123' });
        return agent;
    };

    const findTask = (body) => body.tasks.find((t) => t.uid === task.uid);

    beforeEach(async () => {
        owner = await createTestUser({
            email: 'area-owner@example.com',
            timezone: 'UTC',
        });
        const viewer = await createTestUser({
            email: 'area-viewer@example.com',
            timezone: 'UTC',
        });
        ownerAgent = await login('area-owner@example.com');
        viewerAgent = await login('area-viewer@example.com');

        ownerArea = await Area.create({ name: 'Work', user_id: owner.id });
        viewerArea = await Area.create({ name: 'My side', user_id: viewer.id });
        const project = await Project.create({
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
    });

    it('shows the viewer their own placement in /api/tasks', async () => {
        const res = await viewerAgent.get('/api/tasks').query({ type: 'all' });

        expect(res.status).toBe(200);
        const shared = findTask(res.body);
        expect(shared).toBeDefined();
        expect(shared.Project.area_id).toBe(viewerArea.id);
        expect(shared.Project.Area.uid).toBe(viewerArea.uid);
    });

    it('shows the viewer their own placement in /api/task/:uid', async () => {
        const res = await viewerAgent.get(`/api/task/${task.uid}`);

        expect(res.status).toBe(200);
        expect(res.body.Project.area_id).toBe(viewerArea.id);
        expect(res.body.Project.Area.uid).toBe(viewerArea.uid);
    });

    it("keeps the owner's own area for the owner", async () => {
        const list = await ownerAgent.get('/api/tasks').query({ type: 'all' });
        expect(list.status).toBe(200);
        expect(findTask(list.body).Project.Area.uid).toBe(ownerArea.uid);

        const single = await ownerAgent.get(`/api/task/${task.uid}`);
        expect(single.status).toBe(200);
        expect(single.body.Project.Area.uid).toBe(ownerArea.uid);
    });
});
