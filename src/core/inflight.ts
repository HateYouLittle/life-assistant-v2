/**
 * 在途请求追踪（P2-8 / T-1027-02c）。
 *
 * 停机时 `httpServer.close()` 只停止 **accept 新连接**，已建立的 keep-alive 连接
 * （MCP Streamable HTTP 正是长连接）仍可继续发请求；`closeAllConnections()` 又是立刻
 * 掐断 —— 两者之间没有任何「等在途请求收敛」的步骤。于是 `stop()` 在写工具处理到一半时
 * 就 `db.close()`：客户端拿到 500，重试可能产生重复记录。
 *
 * 这里把「是否有请求正在处理」变成显式的在途集合：`stop()` 先 `close()` 拒绝新请求，
 * 再 `waitForIdle(上限)`，最后才关库。超过上限只 warn（不能让停机无限等一个长连接）。
 */
export interface InFlightTracker {
  /** 登记一个在途请求；返回幂等的结束回调（响应结束/连接断开时调用） */
  begin(): () => void;
  /** 等待全部在途结束或超时；返回超时后仍在途的数量 */
  waitForIdle(timeoutMs: number): Promise<number>;
  /** 拒绝新请求（停机开始时调用） */
  close(): void;
  readonly closed: boolean;
  readonly size: number;
}

export function createInFlightTracker(): InFlightTracker {
  const pending = new Set<Promise<void>>();
  let closed = false;

  return {
    begin(): () => void {
      let settle: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        settle = resolve;
      });
      pending.add(done);
      let settled = false;
      return () => {
        if (settled) return;
        settled = true;
        pending.delete(done);
        settle();
      };
    },

    async waitForIdle(timeoutMs: number): Promise<number> {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      while (pending.size > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await Promise.race([
          Promise.allSettled([...pending]),
          // 不能 unref：停机时事件循环可能只剩这一个定时器，unref 后 race 永远不 resolve
          new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, remaining))),
        ]);
      }
      return pending.size;
    },

    close(): void {
      closed = true;
    },

    get closed(): boolean {
      return closed;
    },

    get size(): number {
      return pending.size;
    },
  };
}
