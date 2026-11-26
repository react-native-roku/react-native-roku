/** Browser development mechanics only. React/Metro retain their own caches. */
export function installRokuRefreshRuntime(Refresh, { sessionId, generation }, global = globalThis) {
  if (global.__RNR_ROKU_REFRESH__) throw Error("A Roku refresh runtime is already installed");
  Refresh.injectIntoGlobalHook(global);
  let bindings,
    application,
    pending,
    disposed = false,
    lastError = null;
  const previousErrors = global.ErrorUtils;
  const hadErrors = Object.hasOwn(global, "ErrorUtils");
  const errorUtils = {
    ...previousErrors,
    reportFatalError(error) {
      if (pending) pending.errors.push(error);
      else if (previousErrors?.reportFatalError)
        previousErrors.reportFatalError.call(previousErrors, error);
      else {
        lastError = error?.message ?? String(error);
        // Metro's guard must return normally so it can retire its inGuard flag.
        // Throwing here poisons later optional imports and hot-update recovery.
        if (typeof global.reportError === "function") global.reportError(error);
        else global.console?.error(error);
      }
    },
  };
  global.ErrorUtils = errorUtils;
  let restorePreambleErrors;
  const refresh = {
    createSignatureFunctionForTransform: Refresh.createSignatureFunctionForTransform,
    isLikelyComponentType: Refresh.isLikelyComponentType,
    getFamilyByType: Refresh.getFamilyByType,
    register: Refresh.register,
    performFullRefresh(reason) {
      if (pending) {
        pending.reload = true;
      }
      global.location?.reload();
    },
    performReactRefresh() {
      if (disposed) return;
      try {
        Refresh.performReactRefresh();
      } catch (error) {
        pending?.errors.push(error);
      }
    },
  };
  const previousRefresh = global.__ReactRefresh;
  const hadRefresh = Object.hasOwn(global, "__ReactRefresh");
  global.__ReactRefresh = refresh;
  const runtime = {
    attachRuntime(identity, value) {
      if (
        disposed ||
        bindings ||
        identity.sessionId !== sessionId ||
        identity.generation !== generation
      )
        throw Error("Roku refresh runtime identity changed");
      bindings = value;
      // React Native's error-guard is a Metro startup script. It replaces the
      // bootstrap object, so install through its public handler API only after
      // the preamble has finished. Keep its guard/apply/report methods intact.
      const preambleErrors = global.ErrorUtils;
      if (preambleErrors !== errorUtils) {
        if (
          typeof preambleErrors?.getGlobalHandler === "function" &&
          typeof preambleErrors.setGlobalHandler === "function"
        ) {
          const previousHandler = preambleErrors.getGlobalHandler();
          const handler = (error) => errorUtils.reportFatalError(error);
          preambleErrors.setGlobalHandler(handler);
          restorePreambleErrors = () => {
            if (
              global.ErrorUtils === preambleErrors &&
              preambleErrors.getGlobalHandler() === handler
            )
              preambleErrors.setGlobalHandler(previousHandler);
          };
        } else {
          const adapted = { ...preambleErrors, reportFatalError: errorUtils.reportFatalError };
          global.ErrorUtils = adapted;
          restorePreambleErrors = () => {
            if (global.ErrorUtils === adapted) global.ErrorUtils = preambleErrors;
          };
        }
      }
    },
    setApplication(value, onRefreshed) {
      application = { whenCommitted: () => value.whenCommitted(), onRefreshed };
    },
    beginPatch(identity) {
      if (
        disposed ||
        !bindings ||
        !application ||
        !pending ||
        identity.sessionId !== sessionId ||
        identity.fromGeneration !== generation ||
        identity.updateId !== pending.updateId ||
        identity.generation !== pending.generation
      )
        throw Error("Stale or unrequested Roku refresh patch");
      return bindings;
    },
    async applyUpdate(update) {
      if (
        disposed ||
        pending ||
        !bindings ||
        !application ||
        update.sessionId !== sessionId ||
        update.fromGeneration !== generation
      )
        return { type: "reload" };
      if (
        !Number.isSafeInteger(update.generation) ||
        update.generation !== generation + 1 ||
        !/^[a-f0-9]{64}$/.test(update.updateId) ||
        !Array.isArray(update.moduleIds) ||
        update.moduleIds.some(
          (id) => !["number", "string"].includes(typeof id) || !bindings.__r.getModules().has(id),
        ) ||
        new Set(update.moduleIds).size !== update.moduleIds.length ||
        !Array.isArray(update.paths) ||
        !update.paths.length ||
        new Set(update.paths).size !== update.paths.length ||
        update.paths.some(
          (path) =>
            typeof path !== "string" ||
            !new RegExp("^/refresh/update-" + update.updateId + "-\\d+\\.mjs$").test(path),
        )
      )
        return { type: "reload" };
      pending = { ...update, errors: [], reload: false };
      let applied = false;
      try {
        const patches = [];
        for (const path of update.paths) patches.push(await import(path));
        if (disposed) return { type: "retired" };
        if (patches.some((patch) => typeof patch.apply !== "function")) return { type: "reload" };
        for (const patch of patches) patch.apply();
        applied = true;
        // All update modules have loaded and all factories have been applied in
        // one synchronous batch. Flush React now, including successful peers
        // of a failed module, before acknowledging the host commit. Metro's
        // later coalescing callback sees no remaining React families to update.
        refresh.performReactRefresh();
        if (disposed) return { type: "retired" };
        if (pending.reload) return { type: "reload" };
        await application?.whenCommitted();
        generation = update.generation;
        lastError =
          pending.errors.map((error) => error?.message ?? String(error)).join("\n") || null;
        if (!lastError) application?.onRefreshed?.();
        return { type: lastError ? "error" : "refreshed", error: lastError };
      } catch (error) {
        if (!applied) return { type: "reload", reason: error?.message ?? String(error) };
        generation = update.generation;
        lastError = error?.message ?? String(error);
        return { type: "error", error: lastError };
      } finally {
        pending = null;
      }
    },
    snapshot() {
      return { sessionId, generation, pending: !!pending, disposed, error: lastError };
    },
    dispose() {
      disposed = true;
      application = bindings = null;
      restorePreambleErrors?.();
      if (global.ErrorUtils === errorUtils) {
        if (hadErrors) global.ErrorUtils = previousErrors;
        else delete global.ErrorUtils;
      }
      if (global.__ReactRefresh === refresh) {
        if (hadRefresh) global.__ReactRefresh = previousRefresh;
        else delete global.__ReactRefresh;
      }
      if (global.__RNR_ROKU_REFRESH__ === runtime) delete global.__RNR_ROKU_REFRESH__;
    },
  };
  global.__RNR_ROKU_REFRESH__ = runtime;
  return runtime;
}
