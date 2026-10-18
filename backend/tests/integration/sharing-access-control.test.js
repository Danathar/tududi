const request = require('supertest');
const app = require('../../app');
const { Project, Task, Note, Area, Goal, Tag } = require('../../models');
const templatesService = require('../../modules/templates/service');
const {
    createTestUser,
    acceptAllInvitations,
} = require('../helpers/testUtils');

const login = async (user) => {
    const agent = request.agent(app);
    await agent
        .post('/api/login')
        .send({ email: user.email, password: 'password123' });
    return agent;
};

describe('Sharing access control', () => {
    let owner, mate, stranger, ownerAgent, mateAgent;

    const share = async (resourceType, resourceUid, accessLevel = 'rw') => {
        const res = await ownerAgent.post('/api/shares').send({
            resource_type: resourceType,
            resource_uid: resourceUid,
            target_user_email: mate.email,
            access_level: accessLevel,
        });
        expect(res.status).toBeLessThan(300);
        await acceptAllInvitations(mateAgent);
    };

    beforeEach(async () => {
        const stamp = Date.now();
        owner = await createTestUser({
            email: `sacowner_${stamp}@example.com`,
        });
        mate = await createTestUser({ email: `sacmate_${stamp}@example.com` });
        stranger = await createTestUser({
            email: `sacstranger_${stamp}@example.com`,
        });
        ownerAgent = await login(owner);
        mateAgent = await login(mate);
    });

    describe('moving an item out of a shared container', () => {
        it('revokes access to a task moved out of a shared project', async () => {
            const shared = await Project.create({
                name: 'Shared',
                user_id: owner.id,
            });
            const priv = await Project.create({
                name: 'Private',
                user_id: owner.id,
            });
            const task = await Task.create({
                name: 'Moving task',
                user_id: owner.id,
                project_id: shared.id,
            });
            await share('project', shared.uid);

            expect((await mateAgent.get(`/api/task/${task.uid}`)).status).toBe(
                200
            );

            const move = await ownerAgent
                .patch(`/api/task/${task.uid}`)
                .send({ project_id: priv.id });
            expect(move.status).toBe(200);

            expect(
                (await mateAgent.get(`/api/task/${task.uid}`)).status
            ).not.toBe(200);
            expect(
                (
                    await mateAgent
                        .patch(`/api/task/${task.uid}`)
                        .send({ name: 'hacked' })
                ).status
            ).not.toBe(200);
            await task.reload();
            expect(task.name).toBe('Moving task');
        });

        it('keeps a direct task share when the task leaves a shared project', async () => {
            const shared = await Project.create({
                name: 'Shared',
                user_id: owner.id,
            });
            const priv = await Project.create({
                name: 'Private',
                user_id: owner.id,
            });
            const task = await Task.create({
                name: 'Directly shared',
                user_id: owner.id,
                project_id: shared.id,
            });
            await share('project', shared.uid);
            await share('task', task.uid);

            await ownerAgent
                .patch(`/api/task/${task.uid}`)
                .send({ project_id: priv.id });

            expect((await mateAgent.get(`/api/task/${task.uid}`)).status).toBe(
                200
            );
        });

        it('revokes access to a note moved out of a shared project', async () => {
            const shared = await Project.create({
                name: 'Shared',
                user_id: owner.id,
            });
            const priv = await Project.create({
                name: 'Private',
                user_id: owner.id,
            });
            const note = await Note.create({
                title: 'Moving note',
                content: 'secret',
                user_id: owner.id,
                project_id: shared.id,
            });
            await share('project', shared.uid);

            expect((await mateAgent.get(`/api/note/${note.uid}`)).status).toBe(
                200
            );

            const move = await ownerAgent
                .patch(`/api/note/${note.uid}`)
                .send({ project_uid: priv.uid });
            expect(move.status).toBe(200);

            expect(
                (await mateAgent.get(`/api/note/${note.uid}`)).status
            ).not.toBe(200);
        });

        it('revokes access to a project moved out of a shared area', async () => {
            const area = await Area.create({ name: 'Fam', user_id: owner.id });
            const project = await Project.create({
                name: 'P',
                user_id: owner.id,
                area_id: area.id,
            });
            const task = await Task.create({
                name: 'Inside P',
                user_id: owner.id,
                project_id: project.id,
            });
            await share('area', area.uid);

            expect(
                (await mateAgent.get(`/api/project/${project.uid}`)).status
            ).toBe(200);

            const move = await ownerAgent
                .patch(`/api/project/${project.uid}`)
                .send({ area_id: null });
            expect(move.status).toBe(200);

            expect(
                (await mateAgent.get(`/api/project/${project.uid}`)).status
            ).not.toBe(200);
            expect(
                (await mateAgent.get(`/api/task/${task.uid}`)).status
            ).not.toBe(200);
        });

        it('keeps a direct project share when the project leaves a shared area', async () => {
            const area = await Area.create({ name: 'Fam', user_id: owner.id });
            const project = await Project.create({
                name: 'P',
                user_id: owner.id,
                area_id: area.id,
            });
            await share('area', area.uid);
            // Sharing the project itself as well turns its row into a direct
            // grant, which leaving the area must not take away.
            await share('project', project.uid);

            await ownerAgent
                .patch(`/api/project/${project.uid}`)
                .send({ area_id: null });

            expect(
                (await mateAgent.get(`/api/project/${project.uid}`)).status
            ).toBe(200);
        });
    });

    describe("another user's area or goal", () => {
        let strangerArea, strangerGoal;

        beforeEach(async () => {
            strangerArea = await Area.create({
                name: 'Stranger secret area',
                user_id: stranger.id,
            });
            strangerGoal = await Goal.create({
                title: 'Stranger secret goal',
                user_id: stranger.id,
            });
        });

        it('rejects creating a project in it', async () => {
            const withArea = await ownerAgent
                .post('/api/project')
                .send({ name: 'Mine', area_id: strangerArea.id });
            expect(withArea.status).toBe(400);
            expect(JSON.stringify(withArea.body)).not.toContain(
                'Stranger secret area'
            );

            const withGoal = await ownerAgent
                .post('/api/project')
                .send({ name: 'Mine', goal_id: strangerGoal.id });
            expect(withGoal.status).toBe(400);
        });

        it('rejects moving a project into it', async () => {
            const project = await Project.create({
                name: 'Mine',
                user_id: owner.id,
            });

            const toArea = await ownerAgent
                .patch(`/api/project/${project.uid}`)
                .send({ area_id: strangerArea.id });
            expect(toArea.status).toBe(400);
            expect(JSON.stringify(toArea.body)).not.toContain(
                'Stranger secret area'
            );

            const toGoal = await ownerAgent
                .patch(`/api/project/${project.uid}`)
                .send({ goal_id: strangerGoal.id });
            expect(toGoal.status).toBe(400);
            expect(JSON.stringify(toGoal.body)).not.toContain(
                'Stranger secret goal'
            );

            await project.reload();
            expect(project.area_id).toBeNull();
            expect(project.goal_id).toBeNull();
        });

        it('rejects cloning a template into it', async () => {
            const template = await Project.create({
                name: 'Template',
                user_id: owner.id,
                is_template: true,
            });

            await expect(
                templatesService.cloneTemplate(template.uid, owner.id, {
                    area_uid: strangerArea.uid,
                })
            ).rejects.toThrow('Invalid area.');
        });

        it('lets only the owner change the goal of a shared project', async () => {
            const ownerGoal = await Goal.create({
                title: 'Owner goal',
                user_id: owner.id,
            });
            const project = await Project.create({
                name: 'Shared',
                user_id: owner.id,
                goal_id: ownerGoal.id,
            });
            await share('project', project.uid);

            // A collaborator cannot move the project to another goal ...
            const mateGoal = await Goal.create({
                title: 'Mate goal',
                user_id: mate.id,
            });
            const change = await mateAgent
                .patch(`/api/project/${project.uid}`)
                .send({ goal_id: mateGoal.id });
            expect(change.status).toBe(403);

            // ... but re-sending the current goal with a normal save is fine.
            const resave = await mateAgent
                .patch(`/api/project/${project.uid}`)
                .send({ name: 'Renamed', goal_id: ownerGoal.id });
            expect(resave.status).toBe(200);

            await project.reload();
            expect(project.goal_id).toBe(ownerGoal.id);
            expect(project.name).toBe('Renamed');
        });

        it('still accepts an area the caller owns', async () => {
            const mine = await Area.create({ name: 'Mine', user_id: owner.id });
            const res = await ownerAgent
                .post('/api/project')
                .send({ name: 'Filed', area_id: mine.id });
            expect(res.status).toBe(201);
            expect(res.body.area_id).toBe(mine.id);
        });
    });

    describe("a collaborator's edit to tags", () => {
        it("keeps the owner's tags on a shared note", async () => {
            const note = await Note.create({
                title: 'Shared note',
                content: 'x',
                user_id: owner.id,
            });
            const ownerTag = await Tag.create({
                name: 'household',
                user_id: owner.id,
            });
            await note.setTags([ownerTag]);
            await share('note', note.uid);

            const res = await mateAgent
                .patch(`/api/note/${note.uid}`)
                .send({ title: 'Edited', tags: ['household'] });
            expect(res.status).toBe(200);

            const tags = await note.getTags();
            expect(tags).toHaveLength(1);
            expect(tags[0].id).toBe(ownerTag.id);
            expect(tags[0].user_id).toBe(owner.id);
            expect(
                await Tag.count({
                    where: { user_id: mate.id, name: 'household' },
                })
            ).toBe(0);
        });

        it("keeps the owner's tags on a shared project", async () => {
            const project = await Project.create({
                name: 'Shared project',
                user_id: owner.id,
            });
            const ownerTag = await Tag.create({
                name: 'renovation',
                user_id: owner.id,
            });
            await project.setTags([ownerTag]);
            await share('project', project.uid);

            const res = await mateAgent
                .patch(`/api/project/${project.uid}`)
                .send({ name: 'Edited', tags: [{ name: 'renovation' }] });
            expect(res.status).toBe(200);

            const tags = await project.getTags();
            expect(tags).toHaveLength(1);
            expect(tags[0].id).toBe(ownerTag.id);
            expect(tags[0].user_id).toBe(owner.id);
        });
    });
});
