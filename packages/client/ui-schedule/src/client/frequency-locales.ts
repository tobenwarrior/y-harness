/**
 * Stored-rule and elapsed-duration copy shared by the `schedule.catalog` and
 * `schedule.manager` namespaces.
 *
 * Both namespaces label the same stored rule kinds, describe cron rules with
 * the same `cronPreview` sentence, and word the same relative durations, so
 * their wording for those keys is one source here. The keys either namespace
 * words differently — its one-shot label, its list states, and its own delete
 * and timing copy — stay in that namespace's dictionary.
 * @module
 */

/** English rule and duration copy. */

/** English rule and duration copy. */
export const frequencyEn = {
  'time.locale': 'en',
  'time.utcPrefix': 'UTC',
  'frequency.daily': 'Daily at {time} ({timeZone})',
  'frequency.dailyLocal': 'Daily at {time}',
  'frequency.weekly': 'Weekly on {weekdays} at {time} ({timeZone})',
  'frequency.weeklyLocal': 'Weekly on {weekdays} at {time}',
  'frequency.cron': 'Cron {expression} ({timeZone})',
  'frequency.cronLocal': 'Cron {expression}',
  'frequency.cronRule': '{rule} ({timeZone})',
  'cron.list.join': ', ',
  'cron.part.join': ' ',
  'cron.weekday.name': '{weekday}',
  'cron.weekday.range': '{from}–{to}',
  'cron.months': ' in {months}',
  'cron.day.every': 'Every day{months}',
  'cron.day.weekdays': '{weekdays}{months}',
  'cron.day.monthDays': 'Day {days} of every month{months}',
  'cron.day.both': 'Day {days} of every month or {weekdays}{months}',
  'cron.day.bothStarred': 'Day {days} of every month and {weekdays}{months}',
  'cron.hours.range': '{from}–{to}',
  'cron.hours.list': '{hours}',
  'cron.time.everyMinute': 'Every minute',
  'cron.time.everyMinutes': 'Every {step} minutes',
  'cron.time.joinedEveryMinute': 'every minute',
  'cron.time.joinedEveryMinutes': 'every {step} minutes',
  'cron.time.everyHour': 'Every hour',
  'cron.time.joinedEveryHour': 'every hour',
  'cron.time.everyNHours': 'Every {count} hours',
  'cron.time.joinedEveryNHours': 'every {count} hours',
  'cron.time.hourlyAt': 'Every hour at minute {minutes}',
  'cron.time.joinedHourlyAt': 'every hour at minute {minutes}',
  'cron.time.hoursEveryMinute': 'every minute during hours {hours}',
  'cron.time.hoursEveryMinutes': 'every {step} minutes during hours {hours}',
  'cron.time.at': 'at {times}',
  'cron.time.hoursAt': 'at minute {minutes} of hours {hours}',
  'frequency.weekday.join': ', ',
  'frequency.weekday.1': 'Mon',
  'frequency.weekday.2': 'Tue',
  'frequency.weekday.3': 'Wed',
  'frequency.weekday.4': 'Thu',
  'frequency.weekday.5': 'Fri',
  'frequency.weekday.6': 'Sat',
  'frequency.weekday.7': 'Sun',
  'unit.day.one': 'day',
  'unit.day.other': 'days',
  'unit.hour.one': 'hour',
  'unit.hour.other': 'hours',
  'unit.minute.one': 'minute',
  'unit.minute.other': 'minutes',
  'unit.second.one': 'second',
  'unit.second.other': 'seconds',
  'relative.now': 'Due now',
  'relative.future': 'in {value} {unit}',
  'relative.overdue': '{value} {unit} overdue',
} satisfies Record<string, string>

/** Compatibility export for the retired locale name. */
export const frequencyZh = frequencyEn
