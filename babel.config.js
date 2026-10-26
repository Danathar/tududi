// The presets below are Babel 7 packages, loaded by babel-jest (Babel 7).
// StrykerJS also reads this file when it parses each file it mutates, with
// its own Babel 8; that parse needs none of them, and Babel 7 presets refuse
// to load under Babel 8, so any other Babel major gets an empty config.
module.exports = (api) => {
  api.cache.using(() => process.env.NODE_ENV);
  if (!api.version.startsWith('7.')) return {};
  return {
    presets: [
      '@babel/preset-env',
      '@babel/preset-react',
      '@babel/preset-typescript',
    ],
    plugins: [
      process.env.NODE_ENV !== 'production' && 'react-refresh/babel',
    ].filter(Boolean),
  };
};
