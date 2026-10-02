/**
 * The canonical statement authoring-surface catalog — one entry per engine
 * statement schema, mapping the surface key to its stored `mvp:` name. This is
 * SDK metadata (it drives the agent-grounding manifest and the coverage report),
 * so it lives in `src` rather than the test tree.
 *
 * A key normally mirrors the engine's own statement-schema filename, which
 * keeps this catalog checkable against the engine one line at a time. One entry
 * deliberately does not: `microservice.request` is stored as
 * `mvp:microservice_request` and the engine files its schema under the `api`
 * namespace, but a microservice is a first-class workspace object here — with
 * its own def factory and deploy path — so its call statement is filed beside
 * it. The same decision is mirrored in codegen, which is what keeps the
 * generated factory tree in agreement with this key.
 *
 * A second entry does the same: `lambda` is stored as `mvp:lambda` and the
 * engine files its schema under the `api` namespace, but a lambda runs wherever
 * a stack runs — in functions, tasks, middleware, and triggers, not only APIs —
 * so filing it under `s.api.*` said something false about where it is available.
 * It is `s.lambda`, with the matching `NAMESPACE_OVERRIDES` entry.
 *
 * One surface-pair shares a stored name (so the catalog has one fewer unique
 * stored name than surfaces): `util.get_raw_input`/`util.get_input` →
 * `mvp:get_input`.
 *
 * `raw()` (from `@xano/sdk/codegen`) is deliberately **not** in this catalog
 * and not under `s.`: it is a verbatim passthrough for stored statements the
 * catalog cannot model, emitted by codegen, not authored by hand.
 */

/** Every engine statement schema file → its stored `mvp:` name. */
export const STATEMENT_SURFACES: ReadonlyArray<readonly [string, string]> = [
  ["action.call", "mvp:action"],
  ["action.package.call", "mvp:action_package"],
  ["addon.call", "mvp:workspace_run_addon"],
  ["ai.agent.run", "mvp:call_agent"],
  ["ai.external.mcp.server_details", "mvp:mcp_server_details"],
  ["ai.external.mcp.tool.list", "mvp:mcp_list_tools"],
  ["ai.external.mcp.tool.run", "mvp:mcp_call_tool"],
  ["api.call", "mvp:workspace_run_endpoint"],
  ["api.realtime_event", "mvp:realtime_event"],
  ["api.request", "mvp:api_request"],
  ["api.stream", "mvp:streaming_api_response"],
  ["array.difference", "mvp:array_difference"],
  ["array.every", "mvp:array_every"],
  ["array.filter_count", "mvp:array_filter_count"],
  ["array.filter", "mvp:array_filter"],
  ["array.find_index", "mvp:array_find_index"],
  ["array.find", "mvp:array_find"],
  ["array.group_by", "mvp:array_group_by"],
  ["array.has", "mvp:array_has"],
  ["array.intersection", "mvp:array_intersection"],
  ["array.map", "mvp:array_map"],
  ["array.merge", "mvp:array_merge"],
  ["array.partition", "mvp:array_partition"],
  ["array.pop", "mvp:array_pop"],
  ["array.push", "mvp:array_push"],
  ["array.shift", "mvp:array_shift"],
  ["array.union", "mvp:array_union"],
  ["array.unshift", "mvp:array_unshift"],
  ["await", "mvp:async_function_await"],
  ["break", "mvp:foreach_break"],
  ["cloud.algolia.request", "mvp:algolia_request"],
  ["cloud.aws.opensearch.document", "mvp:amazon_opensearch_document"],
  ["cloud.aws.opensearch.query", "mvp:amazon_opensearch_query"],
  ["cloud.aws.opensearch.request", "mvp:amazon_opensearch_request"],
  ["cloud.aws.s3.delete_file", "mvp:amazon_s3_delete_file"],
  ["cloud.aws.s3.get_file_info", "mvp:amazon_s3_get_file_metadata"],
  ["cloud.aws.s3.list_directory", "mvp:amazon_s3_list_directory"],
  ["cloud.aws.s3.read_file", "mvp:amazon_s3_create_var_from_file_resource"],
  ["cloud.aws.s3.sign_url", "mvp:amazon_s3_signed_url"],
  ["cloud.aws.s3.upload_file", "mvp:amazon_s3_upload_file"],
  ["cloud.azure.storage.delete_file", "mvp:azure_blob_storage_delete_file"],
  ["cloud.azure.storage.get_file_info", "mvp:azure_blob_storage_get_file_metadata"],
  ["cloud.azure.storage.list_directory", "mvp:azure_blob_storage_list_directory"],
  ["cloud.azure.storage.read_file", "mvp:azure_blob_storage_create_var_from_file_resource"],
  ["cloud.azure.storage.sign_url", "mvp:azure_blob_storage_signed_url"],
  ["cloud.azure.storage.upload_file", "mvp:azure_blob_storage_upload_file"],
  ["cloud.elasticsearch.document", "mvp:elasticsearch_document"],
  ["cloud.elasticsearch.query", "mvp:elasticsearch_query"],
  ["cloud.elasticsearch.request", "mvp:elasticsearch_request"],
  ["cloud.google.storage.delete_file", "mvp:google_cloud_storage_delete_file"],
  ["cloud.google.storage.get_file_info", "mvp:google_cloud_storage_get_file_metadata"],
  ["cloud.google.storage.list_directory", "mvp:google_cloud_storage_list_directory"],
  ["cloud.google.storage.read_file", "mvp:google_cloud_storage_create_var_from_file_resource"],
  ["cloud.google.storage.sign_url", "mvp:google_cloud_storage_signed_url"],
  ["cloud.google.storage.upload_file", "mvp:google_cloud_storage_upload_file"],
  ["cloud.job.await", "mvp:cloud_job_await"],
  ["cloud.job.status", "mvp:cloud_job_status"],
  ["cloud.job", "mvp:cloud_job"],
  ["comment", "mvp:comment"],
  ["conditional", "mvp:conditional"],
  ["continue", "mvp:foreach_continue"],
  ["datadog.log_bulk", "mvp:datadog_log_bulk"],
  ["datadog.log", "mvp:datadog_log"],
  ["datadog.metric_bulk", "mvp:datadog_metric_bulk"],
  ["datadog.metric", "mvp:datadog_metric"],
  ["db.add_or_edit", "mvp:dbo_addoreditby"],
  ["db.add", "mvp:dbo_add"],
  ["db.bulk.add", "mvp:dbo_bulkadd"],
  ["db.bulk.delete", "mvp:dbo_bulkdelete"],
  ["db.bulk.patch", "mvp:dbo_bulkpatch"],
  ["db.bulk.update", "mvp:dbo_bulkupdate"],
  ["db.del", "mvp:dbo_delby"],
  ["db.direct_query", "mvp:dbo_direct_query"],
  ["db.edit", "mvp:dbo_editby"],
  ["db.external.mssql.direct_query", "mvp:dbo_external_mssql_query"],
  ["db.external.mysql.direct_query", "mvp:dbo_external_mysql_query"],
  ["db.external.oracle.direct_query", "mvp:dbo_external_oracle_query"],
  ["db.external.postgres.direct_query", "mvp:dbo_external_postgres_query"],
  ["db.external.snowflake.direct_query", "mvp:dbo_external_snowflake_query"],
  ["db.get", "mvp:dbo_getby"],
  ["db.has", "mvp:dbo_hasby"],
  ["db.increment", "mvp:dbo_increment"],
  ["db.patch", "mvp:dbo_patch"],
  ["db.query", "mvp:dbo_view"],
  ["db.schema", "mvp:dbo_get_schema"],
  ["db.set_datasource", "mvp:set_data_source"],
  ["db.transaction", "mvp:db_transaction"],
  ["db.truncate", "mvp:dbo_truncate"],
  ["debug.log", "mvp:debug_log"],
  ["debug.stop", "mvp:die"],
  ["for", "mvp:for"],
  ["foreach.remove", "mvp:foreach_remove"],
  ["foreach", "mvp:foreach"],
  ["function.call", "mvp:workspace_run_function"],
  ["function.run", "mvp:function"],
  ["group", "mvp:group"],
  ["lambda", "mvp:lambda"],
  ["math.add", "mvp:math_add"],
  ["math.bitwise.and", "mvp:bitwise_and"],
  ["math.bitwise.or", "mvp:bitwise_or"],
  ["math.bitwise.xor", "mvp:bitwise_xor"],
  ["math.div", "mvp:math_div"],
  ["math.mod", "mvp:math_mod"],
  ["math.mul", "mvp:math_mul"],
  ["math.sub", "mvp:math_sub"],
  ["mcp.elicit", "mvp:mcp_elicit"],
  ["mcp.oauth.complete", "mvp:mcp_oauth_complete"],
  ["mcp.oauth.request", "mvp:mcp_oauth_request"],
  ["mcp.oauth.revoke", "mvp:mcp_oauth_revoke"],
  ["mcp.progress", "mvp:mcp_progress"],
  ["middleware.call", "mvp:workspace_run_middleware"],
  ["microservice.request", "mvp:microservice_request"],
  ["object.entries", "mvp:object_entries"],
  ["object.keys", "mvp:object_keys"],
  ["object.values", "mvp:object_values"],
  // `mvp:placeholder` has no surface on purpose. The engine writes one in place
  // of a statement it could not resolve and then refuses the same bytes on
  // import, so authoring one can only produce an un-deployable workspace. It is
  // listed in {@link DECODE_ONLY_STATEMENTS}, carried through `raw()`, and
  // blocked at `export()` — the same treatment retired versions get, and for the
  // same reason: keeping it out of this catalog keeps it out of the manifest an
  // agent authors from.
  ["precondition", "mvp:precondition"],
  ["realtime.get_session", "mvp:get_session"],
  ["realtime.publish", "mvp:realtime_publish"],
  ["redis.count", "mvp:redis_countlist"],
  ["redis.decr", "mvp:redis_decr"],
  ["redis.del", "mvp:redis_del"],
  ["redis.get", "mvp:redis_get"],
  ["redis.has", "mvp:redis_has"],
  ["redis.incr", "mvp:redis_incr"],
  ["redis.keys", "mvp:redis_keys"],
  ["redis.pop", "mvp:redis_poplist"],
  ["redis.push", "mvp:redis_pushlist"],
  ["redis.range", "mvp:redis_rangelist"],
  ["redis.ratelimit", "mvp:redis_ratelimit"],
  ["redis.remove", "mvp:redis_remove_list"],
  ["redis.set", "mvp:redis_set"],
  ["redis.shift", "mvp:redis_shiftlist"],
  ["redis.unshift", "mvp:redis_unshiftlist"],
  ["return", "mvp:return"],
  ["security.check_password", "mvp:check_pass"],
  ["security.create_auth_token", "mvp:create_auth"],
  ["security.create_curve_key", "mvp:crypto_create_ec_key"],
  ["security.create_password", "mvp:generate_pass"],
  ["security.create_rsa_key", "mvp:crypto_create_rsa_key"],
  ["security.create_secret_key", "mvp:crypto_create_octet_key"],
  ["security.create_uuid", "mvp:uuid4"],
  ["security.decrypt", "mvp:crypto_decrypt"],
  ["security.encrypt", "mvp:crypto_encrypt"],
  // Only the LATEST of each versioned crypto family is authorable. The earlier
  // spellings still run and still appear in pulled workspaces, but each version
  // was a breaking change to the one before it, so offering them would invite
  // authoring against a retired contract. They are listed in
  // {@link SUPERSEDED_STATEMENTS} and carried through `raw()` instead — which
  // also keeps them out of the agent-grounding manifest, since that is built
  // from this catalog.
  ["security.jwe_decode", "mvp:crypto_jwe_decode2"],
  ["security.jwe_encode", "mvp:crypto_jwe_encode3"],
  ["security.jws_decode", "mvp:crypto_jws_decode2"],
  ["security.jws_encode", "mvp:crypto_jws_encode2"],
  ["security.random_bytes", "mvp:random_bytes"],
  ["security.random_number", "mvp:rand"],
  ["stack|expect.to_be_defined", "mvp:test_expect_to_be_defined"],
  ["stack|expect.to_be_empty", "mvp:test_expect_to_be_empty"],
  ["stack|expect.to_be_false", "mvp:test_expect_to_be_false"],
  ["stack|expect.to_be_greater_than", "mvp:test_expect_to_be_greater_than"],
  ["stack|expect.to_be_in_the_future", "mvp:test_expect_to_be_in_the_future"],
  ["stack|expect.to_be_in_the_past", "mvp:test_expect_to_be_in_the_past"],
  ["stack|expect.to_be_less_than", "mvp:test_expect_to_be_less_than"],
  ["stack|expect.to_be_null", "mvp:test_expect_to_be_null"],
  ["stack|expect.to_be_true", "mvp:test_expect_to_be_true"],
  ["stack|expect.to_be_within", "mvp:test_expect_to_be_within"],
  ["stack|expect.to_contain", "mvp:test_expect_to_contain"],
  ["stack|expect.to_end_with", "mvp:test_expect_to_end_with"],
  ["stack|expect.to_equal", "mvp:test_expect_to_equal"],
  ["stack|expect.to_match", "mvp:test_expect_to_match"],
  ["stack|expect.to_not_be_defined", "mvp:test_expect_to_not_be_defined"],
  ["stack|expect.to_not_be_null", "mvp:test_expect_to_not_be_null"],
  ["stack|expect.to_not_equal", "mvp:test_expect_to_not_equal"],
  ["stack|expect.to_start_with", "mvp:test_expect_to_start_with"],
  ["stack|expect.to_throw", "mvp:test_expect_to_throw"],
  ["storage.create_attachment", "mvp:create_attachment"],
  ["storage.create_audio", "mvp:create_audio"],
  ["storage.create_file_resource", "mvp:create_file_resource"],
  ["storage.create_image", "mvp:create_image"],
  ["storage.create_video", "mvp:create_video"],
  ["storage.delete_file", "mvp:delete_file"],
  ["storage.read_file_resource", "mvp:create_var_from_file_resource"],
  ["storage.sign_private_url", "mvp:vault_sign_url"],
  ["stream.from_csv", "mvp:csv_stream"],
  ["stream.from_jsonl", "mvp:jsonl_stream"],
  ["stream.from_request", "mvp:streaming_api_request"],
  ["switch", "mvp:switch"],
  ["task.call", "mvp:workspace_run_task"],
  ["text.append", "mvp:text_append"],
  ["text.contains", "mvp:text_contains"],
  ["text.ends_with", "mvp:text_ends_with"],
  ["text.icontains", "mvp:text_icontains"],
  ["text.iends_with", "mvp:text_iends_with"],
  ["text.istarts_with", "mvp:text_istarts_with"],
  ["text.ltrim", "mvp:text_ltrim"],
  ["text.prepend", "mvp:text_prepend"],
  ["text.rtrim", "mvp:text_rtrim"],
  ["text.starts_with", "mvp:text_starts_with"],
  ["text.trim", "mvp:text_trim"],
  ["throw", "mvp:throw_error"],
  ["tool.call", "mvp:workspace_run_tool"],
  ["trigger.call", "mvp:workspace_run_trigger"],
  ["try_catch", "mvp:try_catch"],
  ["util.geo_distance", "mvp:calculate_geo_distance"],
  ["util.get_all_input", "mvp:get_all_input"],
  ["util.get_env", "mvp:get_env"],
  ["util.get_input", "mvp:get_input"],
  ["util.get_raw_input", "mvp:get_input"],
  ["util.get_vars", "mvp:get_vars"],
  ["util.ip_lookup", "mvp:ipaddress_lookup"],
  ["util.post_process", "mvp:post_process"],
  ["util.send_email", "mvp:send_email"],
  ["util.set_header", "mvp:setheader"],
  ["util.sleep", "mvp:sleep"],
  ["util.template_engine", "mvp:template_string"],
  ["var.update", "mvp:update_var"],
  ["var", "mvp:set_var"],
  ["webflow.request", "mvp:connect_webflow_api_request"],
  ["while", "mvp:while"],
  ["workflow_test.call", "mvp:workspace_run_workflow_test"],
  ["zip.add_to_archive", "mvp:zip_add_file_resource"],
  ["zip.create_archive", "mvp:zip_create_file_resource"],
  ["zip.delete_from_archive", "mvp:zip_delete_file_resource"],
  ["zip.extract", "mvp:zip_extract_file_resource"],
  ["zip.view_contents", "mvp:zip_view_contents"],
];

/** Total authoring surfaces (= engine statement schema file count). */
export const TOTAL_STATEMENTS = STATEMENT_SURFACES.length;

/** Statement authoring surfaces (by schema key). */
export const IMPLEMENTED_STATEMENTS = STATEMENT_SURFACES.map(([key]) => key);

/**
 * Surface keys whose `s.` accessor name differs from the schema basename (the
 * control-flow / var specials authored under engine-internal leaf names).
 */
const SPATH_OVERRIDES: Record<string, string> = {
  break: "foreach_break",
  continue: "foreach_continue",
  "foreach.remove": "foreach_remove",
  "var.update": "update_var",
  var: "set_var",
};

/**
 * The dotted `s.` authoring path for a surface key — e.g. `array.filter` →
 * `array.filter` (reachable as `s.array.filter`), `stack|expect.to_equal` →
 * `expect.to_equal`, `var` → `set_var`. Verified against the live `s` tree by
 * the manifest test.
 */
export function sPathOf(surfaceKey: string): string {
  return SPATH_OVERRIDES[surfaceKey] ?? surfaceKey.replace(/^stack\|/, "");
}
