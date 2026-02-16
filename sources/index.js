const portable = require("./portable");
const standalone = require("./standalone");
const git = require("./git");
const remote = require("./remote");
const cloud = require("./cloud");

const sources = [standalone, portable, git, cloud, remote];

module.exports = sources;
