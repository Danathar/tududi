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
    let owner, ownerAgent, viewerAgent, ownerArea, viewerArea, project, task;

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

    it('shows the viewer their own placement on a task they add to the project', async () => {
        const res = await viewerAgent
            .post('/api/task')
            .send({ name: 'Viewer added task', project_uid: project.uid });

        expect(res.status).toBe(201);
        expect(res.body.Project.area_id).toBe(viewerArea.id);
        expect(res.body.Project.Area.uid).toBe(viewerArea.uid);
    });

    // A viewer can take the project out of their areas (area_id ''), which
    // stores a placement with no area. For them that is "no area", not the
    // owner's area.
    it('shows no area to a viewer who took the project out of their areas', async () => {
        const moved = await viewerAgent
            .patch(`/api/project/${project.uid}`)
            .send({ area_id: '' });
        expect(moved.status).toBe(200);

        const list = await viewerAgent.get('/api/tasks').query({ type: 'all' });
        expect(list.status).toBe(200);
        const listed = findTask(list.body).Project;
        expect(listed.area_id).toBeNull();
        expect(listed.Area).toBeNull();

        const single = await viewerAgent.get(`/api/task/${task.uid}`);
        expect(single.status).toBe(200);
        expect(single.body.Project.area_id).toBeNull();
        expect(single.body.Project.Area).toBeNull();

        const forOwner = await ownerAgent.get(`/api/task/${task.uid}`);
        expect(forOwner.status).toBe(200);
        expect(forOwner.body.Project.Area.uid).toBe(ownerArea.uid);
    });

    it("shows each viewer their own placement, not another viewer's", async () => {
        const second = await createTestUser({
            email: 'area-viewer-2@example.com',
            timezone: 'UTC',
        });
        const secondAgent = await login('area-viewer-2@example.com');
        const secondArea = await Area.create({
            name: 'Second side',
            user_id: second.id,
        });
        await ownerAgent.post('/api/shares').send({
            resource_type: 'project',
            resource_uid: project.uid,
            target_user_email: second.email,
            access_level: 'rw',
        });
        await acceptAllInvitations(secondAgent);
        await UserProjectArea.create({
            user_id: second.id,
            project_id: project.id,
            area_id: secondArea.id,
        });

        const forViewer = await viewerAgent.get(`/api/task/${task.uid}`);
        expect(forViewer.status).toBe(200);
        expect(forViewer.body.Project.Area.uid).toBe(viewerArea.uid);

        const forSecond = await secondAgent.get(`/api/task/${task.uid}`);
        expect(forSecond.status).toBe(200);
        expect(forSecond.body.Project.Area.uid).toBe(secondArea.uid);
    });

    describe('for a recurring task', () => {
        let recurring;

        beforeEach(async () => {
            recurring = await Task.create({
                name: 'Shared daily task',
                user_id: owner.id,
                project_id: project.id,
                recurrence_type: 'daily',
                recurrence_interval: 1,
                due_date: new Date('2030-03-15T00:00:00Z'),
            });
        });

        it('shows the viewer their own placement after skipping an occurrence', async () => {
            const res = await viewerAgent.post(
                `/api/task/${recurring.uid}/skip-occurrence`
            );

            expect(res.status).toBe(200);
            expect(res.body.Project.area_id).toBe(viewerArea.id);
            expect(res.body.Project.Area.uid).toBe(viewerArea.uid);
        });

        it('shows the viewer their own placement after updating the task', async () => {
            const res = await viewerAgent
                .patch(`/api/task/${recurring.uid}`)
                .send({ name: 'Renamed shared daily task' });

            expect(res.status).toBe(200);
            expect(res.body.Project.area_id).toBe(viewerArea.id);
            expect(res.body.Project.Area.uid).toBe(viewerArea.uid);
        });
    });
});
