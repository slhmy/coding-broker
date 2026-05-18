const projectDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

const shortDateTimeFormatter = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
})

const preciseDateTimeFormatter = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
})

export function formatProjectDateTime(value: string | null | undefined) {
  return formatDateTime(value, projectDateTimeFormatter)
}

export function formatShortDateTime(value: string | null | undefined) {
  return formatDateTime(value, shortDateTimeFormatter)
}

export function formatPreciseDateTime(value: string | null | undefined) {
  return formatDateTime(value, preciseDateTimeFormatter)
}

export function parseDateTimeMillis(value: string | null | undefined) {
  if (!value) {
    return null
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return date.getTime()
}

function formatDateTime(
  value: string | null | undefined,
  formatter: Intl.DateTimeFormat
) {
  const timestamp = parseDateTimeMillis(value)
  if (timestamp === null) {
    return "Unknown"
  }
  return formatter.format(timestamp)
}
