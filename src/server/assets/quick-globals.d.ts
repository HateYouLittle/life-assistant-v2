// quick.ts 的前导注入的全局（仅供 checkJs 使用，不进入浏览器脚本）。
declare var token: string | null;
declare function stripTokenParam(search: string): string;
