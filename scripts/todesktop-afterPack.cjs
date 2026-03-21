module.exports = async (context) => (await import('./afterPack.mjs')).default(context)
