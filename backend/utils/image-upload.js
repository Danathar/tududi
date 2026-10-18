const crypto = require('crypto');

// Avatars and project images are served back through /api/uploads, so the
// stored extension comes from the validated MIME type rather than the
// client-supplied filename, and the name itself is unguessable.
const IMAGE_MIME_EXTENSIONS = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
};

const imageFileFilter = (message) => (req, file, cb) => {
    if (IMAGE_MIME_EXTENSIONS[file.mimetype]) {
        return cb(null, true);
    }
    return cb(new Error(message));
};

const randomUploadName = (prefix, mimetype) =>
    `${prefix}-${Date.now()}-${crypto.randomBytes(12).toString('hex')}${
        IMAGE_MIME_EXTENSIONS[mimetype] || ''
    }`;

// A project's image_url is free text: the owner can set it to anything. Only
// the exact form an upload produces names a file of ours, so only that form is
// ever deleted from disk. Another folder, `../`, a query string or an outside
// URL gives null.
const PROJECT_COVER_URL = /^\/api\/uploads\/projects\/([A-Za-z0-9._-]+)$/;

const projectCoverFilename = (imageUrl) => {
    if (typeof imageUrl !== 'string') return null;
    const match = PROJECT_COVER_URL.exec(imageUrl);
    if (!match || match[1] === '.' || match[1] === '..') return null;
    return match[1];
};

module.exports = {
    IMAGE_MIME_EXTENSIONS,
    imageFileFilter,
    randomUploadName,
    projectCoverFilename,
};
