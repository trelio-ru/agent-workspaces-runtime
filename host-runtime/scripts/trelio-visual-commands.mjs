// Value-free command schemas shared by the public controller and browser.
// Reject unknown fields BEFORE private owner state or worker creation.
const fields = { status: [], ready: [], 'show-login': [], screenshot: [], 'read-text': ['query', 'offset', 'includeControls'], submit: ['action', 'frameId', 'x', 'y', 'key', 'url'], 'request-ready': ['frameId'], setup: ['url'], navigate: ['url'], click: ['frameId', 'x', 'y'], 'download-attachment': ['frameId', 'x', 'y'], scroll: ['frameId', 'x', 'y', 'deltaY', 'deltaX'], 'type-text': ['frameId', 'text'], key: ['frameId', 'key'] };
export const validVisualArguments = (operation, args) => Object.hasOwn(fields, operation) && args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).every(key => fields[operation].includes(key)) && Buffer.byteLength(JSON.stringify(args)) <= 32_768;
for (const operation of ['credentials-setup', 'credentials-status', 'credentials-forget', 'authenticate']) fields[operation] = [];
