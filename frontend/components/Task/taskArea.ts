import { Area } from '../../entities/Area';
import { Task } from '../../entities/Task';

// The area a task is filed under: its own area wins over the area of its
// project. Grouping All Tasks by area and the task page's area card both read
// this, so the two views cannot disagree about where a task belongs.
export const getEffectiveArea = (task: Task): Area | null =>
    task.Area || task.Project?.Area || null;
