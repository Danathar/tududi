const { Tag } = require('../../../models');
const { validateTagName } = require('../../tags/tagsService');
const { ValidationError } = require('../../../shared/errors');

// Tags live in a join table, so changing them alone leaves the task row (and
// its updated_at) untouched. CalDAV ETags, the collection CTag and the outbound
// sync all key off updated_at, so touch it when the set of tags really changed
// (#1822).
async function setTagsAndTouch(task, tags) {
    const before = (await task.getTags({ attributes: ['id'] }))
        .map((tag) => tag.id)
        .sort((a, b) => a - b);
    const after = tags.map((tag) => tag.id).sort((a, b) => a - b);

    await task.setTags(tags);

    if (before.join(',') !== after.join(',')) {
        task.changed('updated_at', true);
        await task.save();
    }
}

// Checks the shape and names of a tags payload without touching the
// database, and returns the distinct valid names. Routes call it before they
// write the task, so a bad payload is refused with nothing saved (#245).
function validateTagsInput(tagsData) {
    if (!tagsData) return [];

    if (!Array.isArray(tagsData)) {
        throw new ValidationError('Tags must be an array of tag names.');
    }

    const normalizedTags = tagsData.map((tag) =>
        typeof tag === 'string' ? { name: tag } : tag
    );

    const validTagNames = [];
    const invalidTags = [];

    for (const tag of normalizedTags) {
        if (!tag || typeof tag.name !== 'string') {
            invalidTags.push({
                name: tag && tag.name !== undefined ? tag.name : tag,
                error: 'Tag name must be a string',
            });
            continue;
        }
        const validation = validateTagName(tag.name);
        if (validation.valid) {
            if (!validTagNames.includes(validation.name)) {
                validTagNames.push(validation.name);
            }
        } else {
            invalidTags.push({ name: tag.name, error: validation.error });
        }
    }

    if (invalidTags.length > 0) {
        throw new ValidationError(
            `Invalid tag names: ${invalidTags.map((t) => `"${t.name}" (${t.error})`).join(', ')}`
        );
    }

    return validTagNames;
}

async function updateTaskTags(task, tagsData, userId) {
    if (!tagsData) return;

    const validTagNames = validateTagsInput(tagsData);

    if (validTagNames.length === 0) {
        await setTagsAndTouch(task, []);
        return;
    }

    const existingTags = await Tag.findAll({
        where: { user_id: userId, name: validTagNames },
    });

    const existingTagNames = existingTags.map((tag) => tag.name);
    const newTagNames = validTagNames.filter(
        (name) => !existingTagNames.includes(name)
    );

    const createdTags = await Promise.all(
        newTagNames.map((name) => Tag.create({ name, user_id: userId }))
    );

    const allTags = [...existingTags, ...createdTags];
    await setTagsAndTouch(task, allTags);
}

module.exports = {
    validateTagsInput,
    updateTaskTags,
};
