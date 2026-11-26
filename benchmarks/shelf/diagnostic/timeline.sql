SELECT s.id, s.ts, s.dur, s.parent_id, s.name,
       COALESCE(thread.name, track.name) AS track,
       EXTRACT_ARG(s.arg_set_id, 'debug.key') AS key,
       COALESCE(EXTRACT_ARG(s.arg_set_id, 'debug.isKeyPress'),
                EXTRACT_ARG(s.arg_set_id, 'debug.press')) AS press,
       EXTRACT_ARG(s.arg_set_id, 'debug.event') AS event,
       EXTRACT_ARG(s.arg_set_id, 'debug.jsMs') AS jsMs,
       EXTRACT_ARG(s.arg_set_id, 'debug.input') AS input,
       EXTRACT_ARG(s.arg_set_id, 'debug.generation') AS generation,
       EXTRACT_ARG(s.arg_set_id, 'debug.commit') AS commitId,
       EXTRACT_ARG(s.arg_set_id, 'debug.card') AS card,
       EXTRACT_ARG(s.arg_set_id, 'debug.target') AS target,
       EXTRACT_ARG(s.arg_set_id, 'debug.pending') AS pending,
       EXTRACT_ARG(s.arg_set_id, 'debug.node') AS node,
       EXTRACT_ARG(s.arg_set_id, 'debug.field') AS field,
       EXTRACT_ARG(s.arg_set_id, 'debug.data') AS data,
       EXTRACT_ARG(s.arg_set_id, 'debug.phase') AS phase,
       EXTRACT_ARG(s.arg_set_id, 'debug.reuse') AS reuse,
       EXTRACT_ARG(s.arg_set_id, 'debug.walkVisits') AS walkVisits,
       EXTRACT_ARG(s.arg_set_id, 'debug.fieldCount') AS fieldCount,
       EXTRACT_ARG(s.arg_set_id, 'debug.placementCount') AS placementCount,
       EXTRACT_ARG(s.arg_set_id, 'debug.realized') AS realized,
       EXTRACT_ARG(s.arg_set_id, 'debug.count') AS affected,
       EXTRACT_ARG(s.arg_set_id, 'debug.function') AS callback,
       CASE WHEN s.name = 'observer.callback'
         AND EXTRACT_ARG(s.arg_set_id, 'debug.function') GLOB 'shelfNativeFocus[0-9]*'
         AND EXISTS (SELECT 1 FROM descendant_slice(s.id) AS inner
                     WHERE inner.name = 'Print')
         THEN 'shelf-' || SUBSTR(EXTRACT_ARG(s.arg_set_id, 'debug.function'), 17)
       END AS nativeCard
FROM slice s
JOIN track ON track.id = s.track_id
LEFT JOIN thread_track ON thread_track.id = track.id
LEFT JOIN thread ON thread.utid = thread_track.utid
WHERE s.name IN (
  'shelf.mark', 'keyEvent', 'observer.callback', 'Print', 'transaction.start',
  'transaction.commit', 'transaction.toTS.commit', 'transaction.end', 'render', 'swapBuffers'
)
ORDER BY s.ts, s.id;
