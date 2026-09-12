declare module "lunar-javascript" {
  export class Solar {
    static fromYmd(year: number, month: number, day: number): Solar;
    static fromDate(date: Date): Solar;
    getYear(): number;
    getMonth(): number;
    getDay(): number;
    toYmd(): string;
    getLunar(): Lunar;
  }

  export class Lunar {
    /** month 为负数表示闰月（如 -6 = 闰六月）；日期越界时抛错 */
    static fromYmd(year: number, month: number, day: number): Lunar;
    static fromDate(date: Date): Lunar;
    getSolar(): Solar;
    getYear(): number;
    getMonth(): number;
    getDay(): number;
  }

  export class LunarYear {
    static fromYear(year: number): LunarYear;
    /** 返回闰几月（1-12），无闰月返回 0 */
    getLeapMonth(): number;
    getMonths(): LunarMonth[];
  }

  export class LunarMonth {
    /** 负数表示闰月 */
    getMonth(): number;
    getYear(): number;
    isLeap(): boolean;
    getDayCount(): number;
  }
}
