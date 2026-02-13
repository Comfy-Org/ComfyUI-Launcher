const portable = require("./portable");
const standalone = require("./standalone");
const git = require("./git");

const sources = [portable, standalone, git];

module.exports = sources;
