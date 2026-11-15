// Sources: DeepSeek API pricing and State Council holiday notices for 2026 and 2027.
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
// https://www.gov.cn/gongbao/2025/issue_12406/material/gwygb202532.pdf
// https://www.gov.cn/zhengce/content/202611/content_7085101.htm
const holidayRanges = {
  2026: [['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'], ['05-01', '05-05'], ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07']],
  2027: [['01-01', '01-03'], ['02-05', '02-13'], ['04-03', '04-05'], ['05-01', '05-05'], ['06-09', '06-09'], ['09-15', '09-15'], ['10-01', '10-07']],
}
const chinaOffsetMs = 8 * 60 * 60 * 1000

/** Price window at the time a new model request would be admitted. */
export function deepseekPriceWindow(now) {
  const china = new Date(now + chinaOffsetMs)
  const weekday = china.getUTCDay()
  if (weekday === 0 || weekday === 6) return 'offPeak'
  const minute = china.getUTCHours() * 60 + china.getUTCMinutes()
  const peakHours = (minute >= 9 * 60 && minute < 12 * 60) || (minute >= 14 * 60 && minute < 18 * 60)
  if (!peakHours) return 'offPeak'
  const date = china.toISOString().slice(5, 10)
  const holidays = holidayRanges[china.getUTCFullYear()] ?? []
  return holidays.some(([start, end]) => date >= start && date <= end) ? 'offPeak' : 'peak'
}
