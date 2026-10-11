const packageJson = require('../../package.json');

const REPO = 'Danathar/tududi';

/**
 * The fork build baked into the image by docker-publish.yml, or null when the
 * app runs without it (npm start, tests, a local docker build).
 */
function getBuildInfo() {
    const commit = (process.env.TUDUDI_BUILD_COMMIT || '').trim();
    if (!/^[0-9a-f]{40}$/i.test(commit)) {
        return null;
    }
    const short = commit.slice(0, 7);
    const version = String(packageJson.version).replace(/^v/, '');
    const date = (process.env.TUDUDI_BUILD_DATE || '').trim() || null;
    return {
        commit,
        short,
        date,
        tag: `v${version}-${short}`,
        url: `https://github.com/${REPO}/commit/${commit}`,
    };
}

module.exports = { getBuildInfo };
