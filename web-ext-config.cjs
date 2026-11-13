// Only the extension itself is packaged: keep the server, docs, tests and repo metadata out.
module.exports = { ignoreFiles: ['server', 'docs', 'test', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'web-ext-config.cjs', '.github', '.gitignore', 'screenshots', 'store', 'PRIVACY.md', 'CHANGELOG.md', 'icons/icon.svg', 'tools'] };
