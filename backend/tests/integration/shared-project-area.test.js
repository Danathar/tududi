'use strict';

const request = require('supertest');
const app = require('../../app');
const { Area, Project, UserProjectArea } = require('../../models');
const {
    createTestUser,
    acceptAllInvitations,
} = require('../helpers/testUtils');

// Someone a project is shared with can place it in one of their own areas.
// The project's own page, and the responses to editing or completing it, must
// show that placement to them, and the owner's area to the owner.
describe('Area of a shared project in project responses', () => {
    let ownerAgent, viewerAgent, ownerArea, viewerArea, project;

    const login = async (email) => {
        const agent = request.agent(app);
        await agent.post('/api/login').send({ email, password: 'password123' });
        return agent;
    };

    beforeEach(async () => {
        const owner = await createTestUser({
            email: 'proj-area-owner@example.com',
            timezone: 'UTC',
        });
        const viewer = await createTestUser({
            email: 'proj-area-viewer@example.com',
            timezone: 'UTC',
        });
        ownerAgent = await login('proj-area-owner@example.com');
        viewerAgent = await login('proj-area-viewer@example.com');

        ownerArea = await Area.create({ name: 'Work', user_id: owner.id });
        viewerArea = await Area.create({ name: 'My side', user_id: viewer.id });
        project = await Project.create({
            name: 'Shared plan',
            user_id: owner.id,
            area_id: ownerArea.id,
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

    it("shows the viewer their own placement on the project's page", async () => {
        const res = await viewerAgent.get(`/api/project/${project.uid}`);

        expect(res.status).toBe(200);
        expect(res.body.area_id).toBe(viewerArea.id);
        expect(res.body.Area.uid).toBe(viewerArea.uid);
    });

    it('shows the viewer their own placement after they edit the project', async () => {
        const res = await viewerAgent
            .patch(`/api/project/${project.uid}`)
            .send({ name: 'Renamed shared plan' });

        expect(res.status).toBe(200);
        expect(res.body.name).toBe('Renamed shared plan');
        expect(res.body.area_id).toBe(viewerArea.id);
        expect(res.body.Area.uid).toBe(viewerArea.uid);
    });

    it('shows the viewer their own placement after they complete the project', async () => {
        const res = await viewerAgent
            .post(`/api/project/${project.uid}/complete`)
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.project.area_id).toBe(viewerArea.id);
        expect(res.body.project.Area.uid).toBe(viewerArea.uid);
    });

    it("keeps the owner's own area for the owner", async () => {
        const page = await ownerAgent.get(`/api/project/${project.uid}`);
        expect(page.status).toBe(200);
        expect(page.body.area_id).toBe(ownerArea.id);
        expect(page.body.Area.uid).toBe(ownerArea.uid);

        const edited = await ownerAgent
            .patch(`/api/project/${project.uid}`)
            .send({ name: 'Owner renamed' });
        expect(edited.status).toBe(200);
        expect(edited.body.Area.uid).toBe(ownerArea.uid);
    });
});
