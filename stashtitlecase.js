(function () {
  "use strict";

  const PluginApi = window.PluginApi;
  if (!PluginApi) {
    console.warn("[stashtitlecase] PluginApi not available");
    return;
  }

  const MAX_ATTEMPTS = 40;
  const RETRY_MS = 250;
  const SCENE_PATH = /^\/scenes\/(\d+|new)(?:\/|$)/;

  const SMALL_WORDS = new Set([
    "a",
    "an",
    "the",
    "and",
    "but",
    "or",
    "for",
    "nor",
    "on",
    "at",
    "to",
    "from",
    "by",
    "in",
    "of",
    "as",
    "is",
    "it",
    "vs",
    "vs.",
  ]);

  let injectTimer = null;
  let pageObserver = null;

  function capitalizeSegment(segment) {
    if (!segment) {
      return segment;
    }
    return segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase();
  }

  function capitalizeToken(token, isFirstWord) {
    return token
      .split("-")
      .map(function (part, partIndex) {
        const lower = part.toLowerCase();
        if (!isFirstWord && partIndex === 0 && SMALL_WORDS.has(lower)) {
          return lower;
        }
        return capitalizeSegment(part);
      })
      .join("-");
  }

  function toTitleCase(value) {
    let wordIndex = 0;
    return value.replace(/\S+/g, function (token) {
      const result = capitalizeToken(token, wordIndex === 0);
      wordIndex += 1;
      return result;
    });
  }

  function setInputValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    );
    if (descriptor && descriptor.set) {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function basenameFromPath(path) {
    const normalized = path.replace(/\\/g, "/");
    const i = normalized.lastIndexOf("/");
    return i >= 0 ? normalized.slice(i + 1) : normalized;
  }

  function stripExtension(basename) {
    const lastDot = basename.lastIndexOf(".");
    if (lastDot <= 0) {
      return basename;
    }
    return basename.slice(0, lastDot);
  }

  function normalizeSeparators(value) {
    return value
      .replace(/[_\-.]+/g, function (run) {
        return run.length === 1 ? " " : " - ";
      })
      .trim();
  }

  function parseSceneIdFromPath(pathname) {
    const match = pathname.match(/^\/scenes\/(\d+)(?:\/|$)/);
    return match ? match[1] : null;
  }

  async function fetchPrimaryFilePath(sceneId) {
    const stash = PluginApi.utils?.StashService;
    if (!stash) {
      return null;
    }

    const client = stash.getClient?.();
    const findSceneDocument = PluginApi.GQL?.FindSceneDocument;
    if (client && findSceneDocument) {
      try {
        const response = await client.query({
          query: findSceneDocument,
          variables: { id: sceneId },
          fetchPolicy: "network-only",
        });
        const path = response?.data?.findScene?.files?.[0]?.path;
        if (path) {
          return path;
        }
      } catch {
        // Fall through to legacy query.
      }
    }

    const queryFindScenesByID = stash.queryFindScenesByID;
    if (typeof queryFindScenesByID === "function") {
      const numericId = Number(sceneId);
      if (Number.isFinite(numericId)) {
        try {
          const response = await queryFindScenesByID([numericId]);
          const path = response?.data?.findScenes?.scenes?.[0]?.files?.[0]?.path;
          if (path) {
            return path;
          }
        } catch {
          // No file path available.
        }
      }
    }

    return null;
  }

  async function resolveSourceText(trimmedTitle) {
    if (trimmedTitle) {
      return trimmedTitle;
    }

    const sceneId = parseSceneIdFromPath(window.location.pathname);
    if (!sceneId) {
      return null;
    }

    const filePath = await fetchPrimaryFilePath(sceneId);
    if (!filePath) {
      return null;
    }

    return stripExtension(basenameFromPath(filePath));
  }

  function findSceneRoot() {
    return (
      document.querySelector(".scene-tabs") ||
      document.querySelector("#create-scene-page")
    );
  }

  function findTitleInput() {
    const details = document.querySelector("#scene-edit-details");
    if (!details) {
      return null;
    }
    return (
      details.querySelector('.form-group[data-field="title"] input.text-input') ||
      details.querySelector("input#title")
    );
  }

  function unwrapTitleInput(input) {
    const wrap = input.closest(".stc-title-wrap");
    if (!wrap || !wrap.parentNode) {
      input.classList.remove("stc-title-input");
      return;
    }
    wrap.parentNode.insertBefore(input, wrap);
    wrap.remove();
    input.classList.remove("stc-title-input");
  }

  function teardown() {
    if (injectTimer) {
      clearTimeout(injectTimer);
      injectTimer = null;
    }
    if (pageObserver) {
      pageObserver.disconnect();
      pageObserver = null;
    }
    document.querySelectorAll("#scene-edit-details input.stc-title-input").forEach(function (input) {
      unwrapTitleInput(input);
    });
  }

  async function onTitleCaseClick(event) {
    const button = event.currentTarget;
    const wrap = button.closest(".stc-title-wrap");
    const input = wrap && wrap.querySelector("input.text-input, input#title");
    if (!input) {
      return;
    }

    const trimmed = input.value.trim();
    let source = await resolveSourceText(trimmed);
    if (!source) {
      return;
    }

    if (!/\s/.test(source) && /[_\-.]/.test(source)) {
      source = normalizeSeparators(source);
    }

    setInputValue(input, toTitleCase(source));
    input.focus();
  }

  function enhanceTitleInput(input) {
    if (input.closest(".stc-title-wrap")) {
      return true;
    }

    const wrap = document.createElement("div");
    wrap.className = "stc-title-wrap";

    const parent = input.parentNode;
    if (!parent) {
      return false;
    }

    parent.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.classList.add("stc-title-input");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "stc-title-btn";
    button.setAttribute("aria-label", "Apply title case");
    button.textContent = "T";
    button.addEventListener("click", onTitleCaseClick);
    wrap.appendChild(button);

    return true;
  }

  function injectTitleCase() {
    const input = findTitleInput();
    if (!input) {
      return false;
    }
    return enhanceTitleInput(input);
  }

  function watchScenePage() {
    if (pageObserver) {
      pageObserver.disconnect();
    }

    const root = findSceneRoot();
    if (!root) {
      return;
    }

    pageObserver = new MutationObserver(function () {
      if (!SCENE_PATH.test(window.location.pathname) || !findSceneRoot()) {
        teardown();
        return;
      }
      injectTitleCase();
    });

    pageObserver.observe(root, {
      childList: true,
      subtree: true,
    });
  }

  function scheduleInject() {
    if (injectTimer) {
      clearTimeout(injectTimer);
      injectTimer = null;
    }

    let attempts = 0;

    function tryInject() {
      if (!SCENE_PATH.test(window.location.pathname)) {
        return;
      }

      if (injectTitleCase()) {
        watchScenePage();
        return;
      }

      if (findSceneRoot()) {
        watchScenePage();
      }

      attempts += 1;
      if (attempts < MAX_ATTEMPTS) {
        injectTimer = setTimeout(tryInject, RETRY_MS);
      }
    }

    tryInject();
  }

  function onLocationChange(pathname) {
    if (SCENE_PATH.test(pathname)) {
      scheduleInject();
    } else {
      teardown();
    }
  }

  PluginApi.Event.addEventListener("stash:location", function (e) {
    onLocationChange(e.detail.data.location.pathname);
  });

  onLocationChange(window.location.pathname);
})();
