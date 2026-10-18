// Builds the credentials part of a request to a remote CalDAV server from the
// calendar's auth_type. Every request that talks to the server (test
// connection, pull, push, delete) goes through here so a calendar set to
// bearer auth never falls back to Basic auth.
//
// For bearer auth the stored password field holds the token, the same as in
// the test-connection request.

function withRemoteAuth(config, remoteCalendar, password) {
    if (remoteCalendar.auth_type === 'bearer') {
        return {
            ...config,
            headers: {
                ...config.headers,
                Authorization: `Bearer ${password}`,
            },
        };
    }

    return {
        ...config,
        auth: {
            username: remoteCalendar.username,
            password,
        },
    };
}

module.exports = { withRemoteAuth };
