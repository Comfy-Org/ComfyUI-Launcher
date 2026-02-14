const { execFile } = require("child_process");

function cloneComfyUI(pythonPath, installPath) {
  return new Promise((resolve, reject) => {
    // Try pygit2 first
    execFile(
      pythonPath,
      ["-c", "import pygit2; pygit2.clone_repository('https://github.com/Comfy-Org/ComfyUI.git', 'ComfyUI')"],
      { cwd: installPath },
      (error) => {
        if (!error) return resolve();

        // Fall back to system git
        execFile(
          "git",
          ["clone", "--depth", "1", "https://github.com/Comfy-Org/ComfyUI.git", "ComfyUI"],
          { cwd: installPath },
          (gitError, _stdout, gitStderr) => {
            if (gitError) reject(new Error(`ComfyUI clone failed. Neither pygit2 nor system git succeeded.\n${gitStderr || gitError.message}`));
            else resolve();
          },
        );
      },
    );
  });
}

module.exports = { cloneComfyUI };
