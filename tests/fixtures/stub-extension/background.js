self.queryPhash = async () => [];
chrome.runtime.onMessage.addListener((message, sender, reply) => { if (message === 'ready') reply(true); });
