// Used only by the isolated profile verification; never mounted in a real profile.
export const name = 'runtime-log-smoke-runner';
export const inject = ['appReady', 'appExit'];
export function apply(ctx) {
  const exit = ctx.appExit;
  ctx.effect(() => {
    let timer;
    let active = true;
    const cancel = ctx.appReady.onReady(() => {
      if (!active) return;
      ctx.logger.warn('PROFILE_SMOKE_WARN %s', 'ok');
      ctx.logger.error('PROFILE_SMOKE_ERROR');
      ctx.logger.info('PROFILE_SMOKE_INFO');
      timer = setTimeout(() => exit(0), 100);
    });
    return () => { active = false; clearTimeout(timer); cancel(); };
  }, 'runtime-log-smoke-runner');
}
