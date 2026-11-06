'use strict';

const { User } = require('../../models');
const { logError } = require('../../services/logService');
const telegramPoller = require('./telegramPoller');
const { canPollHere } = require('./telegramInitializer');
const { getBotInfo } = require('./telegramApi');
const {
    NotFoundError,
    ValidationError,
    UnauthorizedError,
} = require('../../shared/errors');

async function sendWelcomeMessage(token, chatId) {
    return new Promise((resolve) => {
        const welcomeText = `🎉 Welcome to tududi!\n\nYour personal task management bot is now connected and ready to help!\n\n📝 Simply send me any message and I'll add it to your tududi inbox as an item.\n\n✨ Commands:\n• /help - Show help information\n• Just type any text - Add it as an inbox item\n\nLet's get organized! 🚀`;

        const postData = JSON.stringify({
            chat_id: chatId,
            text: welcomeText,
        });

        const url = `https://api.telegram.org/bot${token}/sendMessage`;

        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
            },
        };

        const req = require('https').request(url, options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    if (response.ok) {
                        console.log('Welcome message sent successfully');
                        resolve(true);
                    } else {
                        logError(
                            'Failed to send welcome message:',
                            response.description
                        );
                        resolve(false);
                    }
                } catch (error) {
                    logError('Error parsing welcome message response:', error);
                    resolve(false);
                }
            });
        });

        req.on('error', (error) => {
            logError('Error sending welcome message:', error);
            resolve(false);
        });

        req.write(postData);
        req.end();
    });
}

// One user's polling status, correct from any process. Only the caller's own
// poller entry is reported: the poller tracks every user on the instance, and
// that map is not this user's business. A process that does not poll cannot
// see the poller's memory, so its `running` follows the wish in the database.
function pollingStatusFor(userId, user) {
    const local = telegramPoller.getStatusForUser(userId);
    const wanted = telegramPoller.isPollingWanted(user);
    const pollingHere = canPollHere();

    return {
        ...local,
        running: pollingHere ? local.running : wanted,
        wanted,
        pollingHere,
    };
}

class TelegramService {
    // The wish goes in the database first. Only the polling process touches
    // its poller here; any other process leaves the bot to that process's
    // next rescan, which also covers a request made before leadership is
    // taken at startup.
    async startPolling(userId) {
        const user = await User.findByPk(userId);
        if (!user || !user.telegram_bot_token) {
            throw new ValidationError('Telegram bot token not set.');
        }

        await user.update({ telegram_polling_enabled: true });

        if (!canPollHere()) {
            return {
                success: true,
                message: 'Telegram polling requested',
                status: pollingStatusFor(userId, user),
            };
        }

        const success = await telegramPoller.addUser(user);

        if (success) {
            return {
                success: true,
                message: 'Telegram polling started',
                status: pollingStatusFor(userId, user),
            };
        } else {
            throw new Error('Failed to start Telegram polling.');
        }
    }

    async stopPolling(userId) {
        // Stored as false, never NULL: NULL counts as wanted. The polling
        // process sees this on its next poll of this user.
        const user = await User.findByPk(userId);
        if (user) await user.update({ telegram_polling_enabled: false });

        if (canPollHere()) telegramPoller.removeUser(userId);

        return {
            success: true,
            message: 'Telegram polling stopped',
            status: pollingStatusFor(userId, user),
        };
    }

    async getPollingStatus(userId) {
        const user = await User.findByPk(userId, {
            attributes: [
                'id',
                'telegram_bot_token',
                'telegram_polling_enabled',
            ],
        });

        return {
            success: true,
            status: pollingStatusFor(userId, user),
        };
    }

    async setup(userId, token) {
        if (!token) {
            throw new ValidationError('Telegram bot token is required.');
        }

        const user = await User.findByPk(userId);
        if (!user) {
            throw new NotFoundError('User not found.');
        }

        // Basic token validation - check if it looks like a Telegram bot token
        if (!/^\d+:[A-Za-z0-9_-]{35}$/.test(token)) {
            throw new ValidationError('Invalid Telegram bot token format.');
        }

        // Get bot info from Telegram API
        // Skip actual API call in test environment
        let botInfo;
        if (process.env.NODE_ENV === 'test') {
            // Mock response for tests
            botInfo = {
                id: 123456789,
                is_bot: true,
                first_name: 'Test Bot',
                username: 'testbot',
            };
        } else {
            botInfo = await getBotInfo(token);
            if (!botInfo) {
                throw new ValidationError(
                    'Invalid bot token or bot not accessible.'
                );
            }
        }

        // Update user's telegram bot token
        // A different bot means the stored chat id no longer applies.
        const updates = { telegram_bot_token: token };
        if (user.telegram_bot_token !== token) updates.telegram_chat_id = null;
        await user.update(updates);

        return {
            success: true,
            message: 'Telegram bot token updated successfully',
            bot: botInfo,
        };
    }

    async sendWelcome(userId, chatId) {
        const user = await User.findByPk(userId);
        if (!user || !user.telegram_bot_token) {
            throw new ValidationError('Telegram bot token not set.');
        }

        if (!chatId) {
            throw new ValidationError('Chat ID is required.');
        }

        // Send welcome message
        const success = await sendWelcomeMessage(
            user.telegram_bot_token,
            chatId
        );

        if (success) {
            return {
                success: true,
                message: 'Welcome message sent successfully',
            };
        } else {
            throw new Error('Failed to send welcome message.');
        }
    }
}

module.exports = new TelegramService();
