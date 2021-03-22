// TODO: add an api to Reify to update cached exports for a module
var ReifyEntry = require('/node_modules/meteor/modules/node_modules/reify/lib/runtime/entry.js');

var SOURCE_URL_PREFIX = "meteor://\uD83D\uDCBBapp"; // Due to the bundler and proxy running in the same node process
// this could possibly be ran after the next build finished
// TODO: the builder should inject a build timestamp in the bundle

var lastUpdated = Date.now();
var appliedChangeSets = [];
var removeErrorMessage = null;
var arch = __meteor_runtime_config__.isModern ? 'web.browser' : 'web.browser.legacy';
var enabled = arch === 'web.browser';

if (!enabled) {
  console.log("HMR is not supported in ".concat(arch));
}

var imported = Object.create(null);
var importedBy = Object.create(null);

if (module._onRequire) {
  module._onRequire({
    before: function before(importedModule, parentId) {
      if (parentId === module.id) {
        // While applying updates we import modules to re-run them.
        // Don't track those imports since we don't want them to affect
        // if a future change to the file can be accepted
        return;
      }

      imported[parentId] = imported[parentId] || new Set();
      imported[parentId].add(importedModule.id);
      importedBy[importedModule.id] = importedBy[importedModule.id] || new Set();
      importedBy[importedModule.id].add(parentId);
    }
  });
}

var pendingReload = function pendingReload() {
  return Reload._reload({
    immediateMigration: true
  });
};

var mustReload = false;

function handleMessage(message) {
  if (message.type === 'register-failed') {
    if (message.reason === 'wrong-app') {
      console.log('HMR: A different app is running on', Meteor.absoluteUrl());
      console.log('HMR: Once you start this app again reload the page to re-enable HMR');
    } else if (message.reason === 'wrong-secret') {
      // TODO: we could wait until the first update to use hot code push
      // instead of reloading the page immediately in case the user has any
      // client state they want to keep for now.
      console.log('HMR: Have the wrong secret, possibly because Meteor was restarted');
      console.log('HMR: Reloading page to get new secret');
      mustReload = true;
      pendingReload();
    } else {
      console.log("HMR: Register failed for unknown reason", message);
    }

    return;
  } else if (message.type === 'app-state') {
    if (removeErrorMessage) {
      removeErrorMessage();
    }

    if (message.state === 'error' && Package['dev-error-overlay']) {
      removeErrorMessage = Package['dev-error-overlay'].DevErrorOverlay.showMessage('Your app is crashing. Here are the latest logs:', message.log.join('\n'));
    }

    return;
  }

  if (message.type !== 'changes') {
    throw new Error("Unknown HMR message type ".concat(message.type));
  }

  var hasUnreloadable = message.changeSets.find(function (changeSet) {
    return !changeSet.reloadable;
  });

  if (pendingReload && hasUnreloadable || message.changeSets.length === 0) {
    if (message.eager) {
      // This was an attempt to reload before the build finishes
      // If we can't, we will wait until the build finishes to properly handle it
      return;
    }

    console.log('HMR: Unable to do HMR. Falling back to hot code push.'); // Complete hot code push if we can not do hot module reload

    mustReload = true;
    return pendingReload();
  } // In case the user changed how a module works with HMR
  // in one of the earlier change sets, we want to apply each
  // change set one at a time in order.


  var succeeded = message.changeSets.filter(function (changeSet) {
    return !appliedChangeSets.includes(changeSet.id);
  }).every(function (changeSet) {
    var applied = applyChangeset(changeSet, message.eager); // We don't record if a module is unreplaceable
    // during an eager update so we can retry and
    // handle the failure after the build finishes

    if (applied || !message.eager) {
      appliedChangeSets.push(changeSet.id);
    }

    return applied;
  });

  if (message.eager) {
    // We will ignore any failures at this time
    // and wait to handle them until the build finishes
    return;
  }

  if (!succeeded) {
    if (pendingReload) {
      console.log('HMR: Some changes can not be applied with HMR. Using hot code push.');
      mustReload = true;
      return pendingReload();
    }

    throw new Error('HMR failed and unable to fallback to hot code push?');
  }

  if (message.changeSets.length > 0) {
    lastUpdated = message.changeSets[message.changeSets.length - 1].linkedAt;
  }
}

var socket;
var pendingMessages = [];

function send(message) {
  if (socket) {
    socket.send(JSON.stringify(message));
  } else {
    pendingMessages.push(message);
  }
}

function connect() {
  if (mustReload) {
    // The page will reload, no reason to
    // connect and show more logs in the console
    return;
  }

  var wsUrl = Meteor.absoluteUrl('/__meteor__hmr__/websocket');
  var protocol = wsUrl.startsWith('https://') ? 'wss://' : 'ws://';
  wsUrl = wsUrl.replace(/^.+\/\//, protocol);
  socket = new WebSocket(wsUrl);
  socket.addEventListener('close', function () {
    socket = null;
    console.log('HMR: websocket closed');
    setTimeout(connect, 2000);
  });
  socket.addEventListener('open', function () {
    console.log('HMR: connected');
    socket.send(JSON.stringify({
      type: 'register',
      arch: arch,
      secret: __meteor_runtime_config__._hmrSecret,
      appId: __meteor_runtime_config__.appId
    }));
    var toSend = pendingMessages.slice();
    pendingMessages = [];
    toSend.forEach(function (message) {
      send(message);
    });
  });
  socket.addEventListener('message', function (event) {
    handleMessage(JSON.parse(event.data));
  });
  socket.addEventListener('error', console.error);
}

connect();

function requestChanges() {
  send({
    type: 'request-changes',
    arch: arch,
    after: lastUpdated
  });
}

function walkTree(pathParts, tree) {
  var part = pathParts.shift();
  var _module = tree.contents[part];

  if (!_module) {
    console.log('HMR: file does not exist', part, pathParts, _module, tree);
    throw new Error('not-exist');
  }

  if (pathParts.length === 0) {
    return _module;
  }

  return walkTree(pathParts, _module);
}

function findFile(moduleId) {
  return walkTree(moduleId.split('/').slice(1), module._getRoot());
} // btoa with unicode support


function utoa(data) {
  return btoa(unescape(encodeURIComponent(data)));
}

function createInlineSourceMap(map) {
  return "//# sourceMappingURL=data:application/json;base64," + utoa(JSON.stringify(map));
}

function createModuleContent(code, map) {
  return function () {
    return eval( // Wrap the function(require,exports,module){...} expression in
    // parentheses to force it to be parsed as an expression.
    // The sourceURL is treated as a prefix for the sources array
    // in the source map
    "(" + code + ")\n//# sourceURL=" + SOURCE_URL_PREFIX + "\n" + createInlineSourceMap(map)).apply(this, arguments);
  };
}

function replaceFileContent(file, contents) {
  // TODO: to replace content in packages, we need an eval function that runs
  // within the package scope, like dynamic imports does.
  var moduleFunction = createModuleContent(contents.code, contents.map, file.module.id);
  file.contents = moduleFunction;
}

function checkModuleAcceptsUpdate(moduleId, checked) {
  checked.add(moduleId);

  if (moduleId === '/') {
    return false;
  }

  var file = findFile(moduleId);
  var moduleHot = file.module.hot;
  var moduleAccepts = moduleHot ? moduleHot._canAcceptUpdate() : false;

  if (moduleAccepts !== null) {
    return moduleAccepts;
  }

  var accepts = null; // The module did not accept the update. If the update is accepted depends
  // on if the modules that imported this module accept the update.

  importedBy[moduleId].forEach(function (depId) {
    if (depId === '/' && importedBy[moduleId].size > 1) {
      // This module was eagerly required by Meteor.
      // Meteor won't know if the module can be updated
      // but we can check with the other modules that imported it.
      return;
    }

    if (checked.has(depId)) {
      // There is a circular dependency
      return;
    }

    var depResult = checkModuleAcceptsUpdate(depId, checked);

    if (accepts !== false) {
      accepts = depResult;
    }
  });
  return accepts === null ? false : accepts;
}

function addFiles(addedFiles) {
  addedFiles.forEach(function (file) {
    var tree = {};
    var segments = file.path.split('/').slice(1);
    var fileName = segments.pop();
    var previous = tree;
    segments.forEach(function (segment) {
      previous[segment] = previous[segment] || {};
      previous = previous[segment];
    });
    previous[fileName] = createModuleContent(file.content.code, file.content.map, file.path);
    meteorInstall(tree, file.meteorInstallOptions);
  });
}

module.constructor.prototype._reset = function (id) {
  var moduleId = id || this.id;
  var file = findFile(moduleId);
  var hotState = file.module._hotState;
  var hotData = {};

  hotState._disposeHandlers.forEach(function (cb) {
    cb(hotData);
  });

  hotState.data = hotData;
  hotState._disposeHandlers = [];
  hotState._hotAccepts = null; // Clear cached exports
  // TODO: check how this affects live bindings for ecmascript modules

  delete file.module.exports;
  var entry = ReifyEntry.getOrCreate(moduleId);
  entry.getters = {};
  entry.setters = {};
  entry.module = null;
  Object.keys(entry.namespace).forEach(function (key) {
    if (key !== '__esModule') {
      delete entry.namespace[key];
    }
  });

  if (imported[moduleId]) {
    imported[moduleId].forEach(function (depId) {
      importedBy[depId].delete(moduleId);
    });
    imported[moduleId] = new Set();
  }
};

module.constructor.prototype._replaceModule = function (id, contents) {
  var moduleId = id || this.id;

  var root = this._getRoot();

  var file;

  try {
    file = walkTree(moduleId.split('/').slice(1), root);
  } catch (e) {
    if (e.message === 'not-exist') {
      return null;
    }

    throw e;
  }

  if (!file.contents) {
    // File is a dynamic import that hasn't been loaded
    return;
  }

  replaceFileContent(file, contents);

  if (!file.module.exports) {
    // File hasn't been imported.
    return;
  }
};

function applyChangeset(_ref) {
  var changedFiles = _ref.changedFiles,
      addedFiles = _ref.addedFiles;
  var canApply = true;
  var toRerun = new Set();
  changedFiles.forEach(function (_ref2) {
    var path = _ref2.path;
    var file = findFile(path); // Check if the file has been imported. If it hasn't been,
    // we can assume update to it can be accepted

    if (file.module.exports) {
      var checked = new Set();
      var accepts = checkModuleAcceptsUpdate(path, checked);

      if (canApply) {
        canApply = accepts;
        checked.forEach(function (moduleId) {
          toRerun.add(moduleId);
        });
      }
    }
  });

  if (!canApply) {
    return false;
  }

  changedFiles.forEach(function (_ref3) {
    var content = _ref3.content,
        path = _ref3.path;

    module._replaceModule(path, content);
  });

  if (addedFiles.length > 0) {
    addFiles(addedFiles);
  }

  toRerun.forEach(function (moduleId) {
    var file = findFile(moduleId); // clear module caches and hot state

    file.module._reset();

    file.module.loaded = false;
  });

  try {
    toRerun.forEach(function (moduleId) {
      require(moduleId);
    });
  } catch (error) {
    console.error('HMR: Error while applying changes:', error);
  }

  var updateCount = changedFiles.length + addedFiles.length;
  console.log("HMR: updated ".concat(updateCount, " ").concat(updateCount === 1 ? 'file' : 'files'));
  return true;
}

var initialVersions = (__meteor_runtime_config__.autoupdate.versions || {})['web.browser'];
var nonRefreshableVersion = initialVersions.versionNonRefreshable;
var replaceableVersion = initialVersions.versionReplaceable;
Meteor.startup(function () {
  if (!enabled) {
    return;
  }

  Package['autoupdate'].Autoupdate._clientVersions.watch(function (doc) {
    if (doc._id !== 'web.browser') {
      return;
    }

    if (nonRefreshableVersion !== doc.versionNonRefreshable) {
      nonRefreshableVersion = doc.versionNonRefreshable;
      console.log('HMR: Some changes can not be applied with HMR. Using hot code push.');
      mustReload = true;
      pendingReload();
    } else if (doc.versionReplaceable !== replaceableVersion) {
      replaceableVersion = doc.versionReplaceable;
      requestChanges();
    }
  }); // We disable hot code push for js until there were
  // changes that can not be applied through HMR.


  Package['reload'].Reload._onMigrate(function (tryReload) {
    if (mustReload) {
      return [true];
    }

    pendingReload = tryReload;
    requestChanges();
    return [false];
  });
});