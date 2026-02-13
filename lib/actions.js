function deleteAction(installation) {
  return {
    id: "delete", label: "Delete", style: "danger", enabled: true,
    showProgress: true, progressTitle: "Deleting…",
    confirm: {
      title: "Delete Installation",
      message: `This will permanently delete all files in:\n${installation.installPath}\n\nThis cannot be undone.`
    }
  };
}

function untrackAction() {
  return {
    id: "remove", label: "Untrack", style: "danger", enabled: true,
    confirm: {
      title: "Untrack Installation",
      message: "This will stop tracking this installation. Files on disk will not be affected."
    }
  };
}

module.exports = { deleteAction, untrackAction };
