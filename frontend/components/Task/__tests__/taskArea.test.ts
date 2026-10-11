import { getEffectiveArea } from '../taskArea';
import { Area } from '../../../entities/Area';
import { Task } from '../../../entities/Task';

const work = { id: 1, uid: 'area-work', name: 'Work' } as Area;
const home = { id: 2, uid: 'area-home', name: 'Home' } as Area;

const makeTask = (overrides: Partial<Task>): Task =>
    ({ id: 1, uid: 'uid-1', name: 'Task', ...overrides }) as Task;

describe('getEffectiveArea', () => {
    it("prefers the task's own area over its project's area", () => {
        const task = makeTask({
            Area: work,
            Project: { id: 9, name: 'Garden', Area: home } as Task['Project'],
        });
        expect(getEffectiveArea(task)).toBe(work);
    });

    it("falls back to the project's area", () => {
        const task = makeTask({
            Project: { id: 9, name: 'Garden', Area: home } as Task['Project'],
        });
        expect(getEffectiveArea(task)).toBe(home);
    });

    it('returns null when neither has an area', () => {
        expect(getEffectiveArea(makeTask({}))).toBeNull();
        expect(
            getEffectiveArea(
                makeTask({
                    Project: { id: 9, name: 'Garden' } as Task['Project'],
                })
            )
        ).toBeNull();
    });
});
