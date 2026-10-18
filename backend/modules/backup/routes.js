'use strict';

const express = require('express');
const multer = require('multer');
const router = express.Router();
const { requireFeature } = require('../../middleware/entitlements');
const { ValidationError } = require('../../shared/errors');
const backupController = require('./controller');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 100 * 1024 * 1024,
    },
    fileFilter: (req, file, cb) => {
        const allowedMimes = [
            'application/json',
            'application/gzip',
            'application/x-gzip',
        ];
        const fileExt = file.originalname.toLowerCase();

        if (
            allowedMimes.includes(file.mimetype) ||
            fileExt.endsWith('.json') ||
            fileExt.endsWith('.gz')
        ) {
            cb(null, true);
        } else {
            cb(
                new ValidationError('Only JSON and gzip files are allowed'),
                false
            );
        }
    },
});

// multer's own errors (a file over the limit) become a 400 instead of a 500,
// the same way entityAttachments.uploadSingleFile does it.
const uploadBackup = (req, res, next) => {
    upload.single('backup')(req, res, (error) => {
        if (error instanceof multer.MulterError) {
            return next(
                new ValidationError(
                    error.code === 'LIMIT_FILE_SIZE'
                        ? 'Backup file exceeds the 100MB limit'
                        : error.message
                )
            );
        }
        return next(error);
    });
};

router.post('/backup/export', backupController.export);
router.post(
    '/backup/import',
    requireFeature('backups_import'),
    uploadBackup,
    backupController.import
);
router.post(
    '/backup/validate',
    requireFeature('backups_import'),
    uploadBackup,
    backupController.validate
);
router.get('/backup/list', backupController.list);
router.get('/backup/:uid/download', backupController.download);
router.post(
    '/backup/:uid/restore',
    requireFeature('backups_import'),
    backupController.restore
);
router.delete('/backup/:uid', backupController.delete);

module.exports = router;
