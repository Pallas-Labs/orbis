-- Listening Time began empty when 20261110000000_listening_time was applied, so Heavy Rotation
-- ignored every Listen recorded before it. This credits each earlier Listen with an estimate:
-- the time from its start until it finished, the Person's next Listen started, or Listening
-- Time began, whichever came first, and never more than the Set's length. A Listen whose start
-- is a guess (start_known = 0) credits the whole Set when it finished and nothing otherwise. A
-- Set with no length credits nothing. Listens after Listening Time began are already counted.
INSERT INTO `listening_time` (`person_id`, `day`, `set_id`, `seconds`)
WITH `began` (`at`) AS (
  SELECT COALESCE(
    (SELECT `applied_at` FROM `__drizzle_migrations` WHERE `name` = '20261110000000_listening_time'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
),
`ordered` AS (
  SELECT `listens`.*, `began`.`at` AS `began_at`,
    LEAD(`started_at`) OVER (PARTITION BY `person_id` ORDER BY `started_at`, `id`) AS `next_at`
  FROM `listens`, `began`
  WHERE `started_at` < `began`.`at`
),
`estimated` AS (
  SELECT `ordered`.`person_id`, substr(`ordered`.`started_at`, 1, 10) AS `day`, `ordered`.`set_id`,
    CASE
      WHEN `sets`.`duration_seconds` IS NULL THEN 0
      WHEN `ordered`.`start_known` = 0 THEN
        CASE WHEN `ordered`.`finished_at` IS NULL THEN 0 ELSE `sets`.`duration_seconds` END
      ELSE MAX(0, MIN(`sets`.`duration_seconds`, CAST(round((julianday(MIN(
        COALESCE(`ordered`.`finished_at`, `ordered`.`began_at`),
        COALESCE(`ordered`.`next_at`, `ordered`.`began_at`)
      )) - julianday(`ordered`.`started_at`)) * 86400) AS INTEGER)))
    END AS `seconds`
  FROM `ordered` JOIN `sets` ON `sets`.`id` = `ordered`.`set_id`
)
SELECT `person_id`, `day`, `set_id`, SUM(`seconds`) FROM `estimated`
WHERE `seconds` > 0
GROUP BY `person_id`, `day`, `set_id`
ON CONFLICT (`person_id`, `day`, `set_id`) DO UPDATE SET `seconds` = `listening_time`.`seconds` + excluded.`seconds`;
