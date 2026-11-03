-- Portable order-review metadata and private-media lifecycle.
--
-- This delta consumes the C-D20 accepted review grants. It adds no issuer,
-- provider, public object URL or direct browser table access. Every routine is
-- SECURITY INVOKER, tables and routines are closed to PUBLIC/anon/authenticated,
-- and the direct Node/Postgres runtime calls them with its private DB principal.

CREATE TABLE public.commerce_order_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE RESTRICT,
  review_reference text NOT NULL UNIQUE,
  rating integer NOT NULL,
  comment text,
  submission_fingerprint text NOT NULL,
  moderation text NOT NULL DEFAULT 'pending',
  access_revoked_at timestamptz,
  state_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_order_reviews_order_key UNIQUE(order_id),
  CONSTRAINT commerce_order_reviews_reference_check CHECK (review_reference ~ '^order-review:[a-f0-9-]{36}$'),
  CONSTRAINT commerce_order_reviews_rating_check CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT commerce_order_reviews_comment_check CHECK (comment IS NULL OR char_length(comment) BETWEEN 1 AND 2000),
  CONSTRAINT commerce_order_reviews_fingerprint_check CHECK (submission_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT commerce_order_reviews_moderation_check CHECK (moderation IN ('pending','visible','hidden')),
  CONSTRAINT commerce_order_reviews_version_check CHECK (state_version > 0),
  CONSTRAINT commerce_order_reviews_revoke_time_check CHECK (access_revoked_at IS NULL OR access_revoked_at>=created_at),
  CONSTRAINT commerce_order_reviews_time_check CHECK (updated_at >= created_at)
);

CREATE TABLE public.commerce_order_review_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES public.commerce_order_reviews(id) ON DELETE RESTRICT,
  media_reference text NOT NULL UNIQUE,
  declared_content_type text NOT NULL,
  declared_byte_length integer NOT NULL,
  observed_content_type text,
  observed_byte_length integer,
  observed_digest text,
  object_key text NOT NULL UNIQUE,
  authorizing_grant_reference text NOT NULL,
  authorizing_grant_kind text NOT NULL,
  capability_digest text NOT NULL UNIQUE,
  capability_expires_at timestamptz NOT NULL,
  capability_consumed_at timestamptz,
  intent_command_key text NOT NULL,
  intent_fingerprint text NOT NULL,
  writer_reference text,
  writer_lease_version bigint NOT NULL DEFAULT 0,
  writer_lease_expires_at timestamptz,
  temp_key text,
  state text NOT NULL DEFAULT 'pending',
  state_version bigint NOT NULL DEFAULT 1,
  cleanup_receipt text UNIQUE,
  reconcile_receipt text UNIQUE,
  reconcile_claimed_at timestamptz,
  reconcile_state_version bigint,
  next_attempt_at timestamptz,
  retry_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_order_review_media_intent_key UNIQUE(review_id,intent_command_key),
  CONSTRAINT commerce_order_review_media_grant_kind_check CHECK (authorizing_grant_kind IN ('review_request','review_effects')),
  CONSTRAINT commerce_order_review_media_reference_check CHECK (media_reference ~ '^order-review-media:[a-f0-9-]{36}$'),
  CONSTRAINT commerce_order_review_media_type_check CHECK (declared_content_type IN ('image/jpeg','image/png','image/webp')),
  CONSTRAINT commerce_order_review_media_length_check CHECK (declared_byte_length BETWEEN 1 AND 20971520),
  CONSTRAINT commerce_order_review_media_observed_type_check CHECK (observed_content_type IS NULL OR observed_content_type IN ('image/jpeg','image/png','image/webp')),
  CONSTRAINT commerce_order_review_media_observed_length_check CHECK (observed_byte_length IS NULL OR observed_byte_length BETWEEN 1 AND 20971520),
  CONSTRAINT commerce_order_review_media_digest_check CHECK (observed_digest IS NULL OR observed_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT commerce_order_review_media_capability_check CHECK (capability_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT commerce_order_review_media_command_check CHECK (intent_command_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  CONSTRAINT commerce_order_review_media_intent_fingerprint_check CHECK (intent_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT commerce_order_review_media_writer_check CHECK (writer_reference IS NULL OR writer_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  CONSTRAINT commerce_order_review_media_state_check CHECK (state IN ('pending','stored','confirmed','cleanup_pending','deleted')),
  CONSTRAINT commerce_order_review_media_version_check CHECK (state_version > 0 AND writer_lease_version >= 0 AND retry_count >= 0
    AND (reconcile_receipt IS NULL)=(reconcile_state_version IS NULL)),
  CONSTRAINT commerce_order_review_media_shape_check CHECK (
    ((state = 'pending') AND observed_digest IS NULL AND observed_byte_length IS NULL AND observed_content_type IS NULL)
    OR ((state IN ('stored','confirmed')) AND observed_digest IS NOT NULL AND observed_byte_length IS NOT NULL AND observed_content_type IS NOT NULL)
    OR state IN ('cleanup_pending','deleted')
  ),
  CONSTRAINT commerce_order_review_media_lease_check CHECK ((writer_reference IS NULL) = (writer_lease_expires_at IS NULL)),
  CONSTRAINT commerce_order_review_media_time_check CHECK (updated_at >= created_at)
);

-- The platform MigrationRunner applies each forward atomically, so a concurrent
-- index/attach sequence cannot be used here. The owner accepted the bounded
-- write-lock window on 2026-08-16 before this direct capability is published.
ALTER TABLE public.subscriber_review_access_grants
  -- squawk-ignore constraint-missing-not-valid,disallowed-unique-constraint
  ADD CONSTRAINT subscriber_review_access_grants_reference_kind_key UNIQUE(grant_reference,kind);
ALTER TABLE public.commerce_order_review_media
  ADD CONSTRAINT commerce_order_review_media_authorizing_grant_fkey
  FOREIGN KEY(authorizing_grant_reference,authorizing_grant_kind)
  REFERENCES public.subscriber_review_access_grants(grant_reference,kind) ON DELETE RESTRICT;

CREATE TABLE public.commerce_order_review_command_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  command_kind text NOT NULL,
  command_key text NOT NULL,
  fingerprint text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_order_review_command_receipts_key UNIQUE(command_kind,command_key),
  CONSTRAINT commerce_order_review_command_receipts_kind_check CHECK (command_kind IN ('media_confirm','moderate','review_revoke','media_delete')),
  CONSTRAINT commerce_order_review_command_receipts_command_check CHECK (command_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  CONSTRAINT commerce_order_review_command_receipts_fingerprint_check CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT commerce_order_review_command_receipts_result_check CHECK (jsonb_typeof(result) = 'object')
);

CREATE TABLE public.commerce_order_review_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES public.commerce_order_reviews(id) ON DELETE RESTRICT,
  media_id uuid REFERENCES public.commerce_order_review_media(id) ON DELETE RESTRICT,
  actor_reference text NOT NULL,
  action text NOT NULL,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  command_fingerprint text NOT NULL,
  idempotency_key text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_order_review_audit_actor_check CHECK (actor_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  CONSTRAINT commerce_order_review_audit_action_check CHECK (action IN ('submit','media_intent','media_confirm','moderate','review_revoke','media_delete','media_stored','media_cleanup')),
  CONSTRAINT commerce_order_review_audit_fingerprint_check CHECK (command_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT commerce_order_review_audit_key_check CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$')
);

-- These supporting indexes share the same atomic forward. CONCURRENTLY is
-- incompatible with the runner transaction; the owner accepted the bounded
-- write-lock window on 2026-08-16 before publication of the reader.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX subscriber_retention_intents_order_review_grant_idx
  ON public.subscriber_retention_intents(access_grant_reference,kind,source_reference,subject_reference,recipient_fingerprint)
  WHERE status = 'accepted' AND kind IN ('review_request','review_effects');
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX subscriber_retention_intents_order_review_parent_idx
  ON public.subscriber_retention_intents(source_reference,subject_reference,recipient_fingerprint)
  WHERE status = 'accepted' AND kind = 'review_request';
CREATE INDEX commerce_order_reviews_admin_cursor_idx ON public.commerce_order_reviews(created_at DESC,id DESC);
CREATE INDEX commerce_order_review_media_cleanup_idx
  ON public.commerce_order_review_media(next_attempt_at,id) WHERE state='cleanup_pending';
CREATE INDEX commerce_order_review_media_expired_lease_idx
  ON public.commerce_order_review_media(writer_lease_expires_at,id)
  WHERE state='pending' AND writer_reference IS NOT NULL;
CREATE INDEX commerce_order_review_media_expired_intent_idx
  ON public.commerce_order_review_media(capability_expires_at,id)
  WHERE state='pending' AND writer_reference IS NULL;
CREATE INDEX commerce_order_review_media_authorizing_grant_idx
  ON public.commerce_order_review_media(authorizing_grant_reference,authorizing_grant_kind);

REVOKE ALL ON TABLE public.commerce_order_reviews, public.commerce_order_review_media,
  public.commerce_order_review_command_receipts, public.commerce_order_review_audit
FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.order_review_refuse_audit_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_catalog AS $$
BEGIN RAISE EXCEPTION 'order_review_audit_append_only' USING ERRCODE='42501'; END; $$;
CREATE TRIGGER commerce_order_review_audit_append_only BEFORE UPDATE OR DELETE
  ON public.commerce_order_review_audit FOR EACH ROW EXECUTE FUNCTION public.order_review_refuse_audit_mutation();
CREATE TRIGGER commerce_order_review_receipts_append_only BEFORE UPDATE OR DELETE
  ON public.commerce_order_review_command_receipts FOR EACH ROW EXECUTE FUNCTION public.order_review_refuse_audit_mutation();
CREATE TRIGGER commerce_order_review_audit_no_truncate BEFORE TRUNCATE
  ON public.commerce_order_review_audit FOR EACH STATEMENT EXECUTE FUNCTION public.order_review_refuse_audit_mutation();
CREATE TRIGGER commerce_order_review_receipts_no_truncate BEFORE TRUNCATE
  ON public.commerce_order_review_command_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.order_review_refuse_audit_mutation();

CREATE FUNCTION public.order_review_resolve_order(p_grant text,p_now timestamptz)
RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_catalog AS $$
  SELECT g.order_id FROM public.subscriber_review_access_grants g
  JOIN public.subscriber_retention_intents i
    ON i.access_grant_reference=g.grant_reference AND i.kind=g.kind
   AND i.source_reference='order:'||g.order_id::text AND i.status='accepted'
  WHERE g.grant_reference=p_grant AND g.revoked_at IS NULL AND g.expires_at>p_now
    AND NOT EXISTS (SELECT 1 FROM public.commerce_order_reviews x
      WHERE x.order_id=g.order_id AND x.access_revoked_at IS NOT NULL)
    AND (g.kind='review_request' OR (g.kind='review_effects' AND EXISTS(
      SELECT 1 FROM public.subscriber_retention_intents r
      WHERE r.kind='review_request' AND r.status='accepted'
        AND r.source_reference=i.source_reference AND r.subject_reference=i.subject_reference
        AND r.recipient_fingerprint=i.recipient_fingerprint)))
  LIMIT 1
$$;

CREATE FUNCTION public.order_review_json(r public.commerce_order_reviews,p_replayed boolean DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_catalog AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('contractVersion','commerce.order-review.v1',
    'reviewRef',r.review_reference,'rating',r.rating,'comment',r.comment,
    'moderation',r.moderation,'createdAt',to_jsonb(r.created_at),'replayed',p_replayed))
$$;
CREATE FUNCTION public.order_review_media_json(m public.commerce_order_review_media)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_catalog AS $$
  SELECT jsonb_build_object('mediaRef',m.media_reference,'declaredContentType',m.declared_content_type,
    'declaredByteLength',m.declared_byte_length,'observedContentType',m.observed_content_type,
    'observedByteLength',m.observed_byte_length,'observedDigest',m.observed_digest,'state',m.state)
$$;

CREATE FUNCTION public.order_review_read(p_grant text,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_catalog AS $$
DECLARE v_order uuid; v_review public.commerce_order_reviews%ROWTYPE;
BEGIN
  v_order:=public.order_review_resolve_order(p_grant,p_now); IF v_order IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_review FROM public.commerce_order_reviews WHERE order_id=v_order;
  IF NOT FOUND THEN RETURN jsonb_build_object('review',NULL,'media','[]'::jsonb); END IF;
  RETURN jsonb_build_object('review',public.order_review_json(v_review),'media',
    (SELECT COALESCE(jsonb_agg(public.order_review_media_json(m) ORDER BY m.created_at,m.id),'[]'::jsonb)
      FROM public.commerce_order_review_media m WHERE m.review_id=v_review.id
        AND m.authorizing_grant_reference=p_grant AND m.state='confirmed'));
END $$;

CREATE FUNCTION public.order_review_submit(p_grant text,p_rating integer,p_comment text,p_fingerprint text,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_catalog AS $$
DECLARE v_order uuid; v_review public.commerce_order_reviews%ROWTYPE;
  v_canonical_fingerprint text;
BEGIN
  IF p_grant IS NULL OR p_rating IS NULL OR p_rating NOT BETWEEN 1 AND 5 OR p_fingerprint IS NULL
     OR p_fingerprint !~ '^[a-f0-9]{64}$' OR p_now IS NULL
     OR (p_comment IS NOT NULL AND (char_length(p_comment)<1 OR char_length(p_comment)>2000))
  THEN RAISE EXCEPTION 'order_review_invalid' USING ERRCODE='22023'; END IF;
  IF p_comment IS NOT NULL AND p_comment<>btrim(p_comment)
  THEN RAISE EXCEPTION 'order_review_invalid' USING ERRCODE='22023'; END IF;
  v_canonical_fingerprint:=encode(sha256(convert_to(p_rating::text||chr(10)||COALESCE(p_comment,''),'UTF8')),'hex');
  IF p_fingerprint<>v_canonical_fingerprint
  THEN RAISE EXCEPTION 'order_review_invalid' USING ERRCODE='22023'; END IF;
  v_order:=public.order_review_resolve_order(p_grant,p_now); IF v_order IS NULL THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.subscriber_review_access_grants
    WHERE grant_reference=p_grant AND revoked_at IS NULL AND expires_at>p_now FOR UPDATE;
  IF NOT FOUND OR public.order_review_resolve_order(p_grant,p_now) IS DISTINCT FROM v_order THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('order-review:'||v_order::text,0));
  SELECT * INTO v_review FROM public.commerce_order_reviews WHERE order_id=v_order FOR UPDATE;
  IF FOUND THEN
    IF v_review.submission_fingerprint<>p_fingerprint THEN
      RAISE EXCEPTION 'order_review_conflict' USING ERRCODE='23505';
    END IF;
    RETURN public.order_review_json(v_review,true);
  END IF;
  INSERT INTO public.commerce_order_reviews(order_id,review_reference,rating,comment,submission_fingerprint,created_at,updated_at)
  VALUES(v_order,'order-review:'||gen_random_uuid()::text,p_rating,p_comment,p_fingerprint,p_now,p_now) RETURNING * INTO v_review;
  INSERT INTO public.commerce_order_review_audit(review_id,actor_reference,action,before_state,after_state,command_fingerprint,occurred_at)
  VALUES(v_review.id,'customer-grant','submit','{}',public.order_review_json(v_review),p_fingerprint,p_now);
  RETURN public.order_review_json(v_review,false);
END $$;

CREATE FUNCTION public.order_review_create_media_intent(p_grant text,p_type text,p_length integer,p_capability_digest text,p_command_key text,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_catalog AS $$
DECLARE v_order uuid; v_review public.commerce_order_reviews%ROWTYPE; v_media public.commerce_order_review_media%ROWTYPE;
  v_fingerprint text; v_grant_kind text; v_media_id uuid:=gen_random_uuid();
BEGIN
  IF p_grant IS NULL OR p_type IS NULL OR p_type NOT IN ('image/jpeg','image/png','image/webp')
     OR p_length IS NULL OR p_length NOT BETWEEN 1 AND 20971520 OR p_capability_digest IS NULL
     OR p_capability_digest !~ '^[a-f0-9]{64}$' OR p_command_key IS NULL
     OR p_command_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' OR p_now IS NULL
  THEN RAISE EXCEPTION 'order_review_invalid' USING ERRCODE='22023'; END IF;
  v_fingerprint:=encode(sha256(convert_to(p_type||':'||p_length::text||':'||p_capability_digest,'UTF8')),'hex');
  v_order:=public.order_review_resolve_order(p_grant,p_now); IF v_order IS NULL THEN RETURN NULL; END IF;
  SELECT kind INTO v_grant_kind FROM public.subscriber_review_access_grants
    WHERE grant_reference=p_grant AND revoked_at IS NULL AND expires_at>p_now FOR UPDATE;
  IF NOT FOUND OR public.order_review_resolve_order(p_grant,p_now) IS DISTINCT FROM v_order THEN RETURN NULL; END IF;
  SELECT * INTO v_review FROM public.commerce_order_reviews WHERE order_id=v_order FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO v_media FROM public.commerce_order_review_media
    WHERE review_id=v_review.id AND intent_command_key=p_command_key FOR UPDATE;
  IF FOUND THEN
    IF v_media.intent_fingerprint<>v_fingerprint THEN RAISE EXCEPTION 'order_review_conflict' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('media',public.order_review_media_json(v_media),'uploadExpiresAt',v_media.capability_expires_at,'replayed',true);
  END IF;
  IF (SELECT count(*) FROM public.commerce_order_review_media WHERE review_id=v_review.id AND state<>'deleted')>=10
  THEN RAISE EXCEPTION 'order_review_conflict' USING ERRCODE='23505'; END IF;
  INSERT INTO public.commerce_order_review_media(id,review_id,media_reference,declared_content_type,declared_byte_length,
    object_key,authorizing_grant_reference,authorizing_grant_kind,capability_digest,capability_expires_at,
    intent_command_key,intent_fingerprint,created_at,updated_at)
  VALUES(v_media_id,v_review.id,'order-review-media:'||v_media_id::text,p_type,p_length,
    'review/'||v_review.id::text||'/'||v_media_id::text,p_grant,v_grant_kind,p_capability_digest,
    p_now+interval '10 minutes',p_command_key,v_fingerprint,p_now,p_now)
  RETURNING * INTO v_media;
  INSERT INTO public.commerce_order_review_audit(review_id,media_id,actor_reference,action,before_state,after_state,command_fingerprint,idempotency_key,occurred_at)
  VALUES(v_review.id,v_media.id,'customer-grant','media_intent','{}',public.order_review_media_json(v_media),v_fingerprint,p_command_key,p_now);
  RETURN jsonb_build_object('media',public.order_review_media_json(v_media),'uploadExpiresAt',v_media.capability_expires_at,'replayed',false);
END $$;

CREATE FUNCTION public.order_review_confirm_media(p_grant text,p_media_ref text,p_digest text,p_command_key text,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_catalog AS $$
DECLARE v_order uuid; v_review public.commerce_order_reviews%ROWTYPE; v_media public.commerce_order_review_media%ROWTYPE;
  v_receipt public.commerce_order_review_command_receipts%ROWTYPE; v_fp text; v_before jsonb;
BEGIN
  IF p_grant IS NULL OR p_media_ref IS NULL OR p_media_ref !~ '^order-review-media:[a-f0-9-]{36}$'
     OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' OR p_command_key IS NULL
     OR p_command_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' OR p_now IS NULL
  THEN RAISE EXCEPTION 'order_review_invalid' USING ERRCODE='22023'; END IF;
  v_order:=public.order_review_resolve_order(p_grant,p_now); IF v_order IS NULL THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.subscriber_review_access_grants
    WHERE grant_reference=p_grant AND revoked_at IS NULL AND expires_at>p_now FOR UPDATE;
  IF NOT FOUND OR public.order_review_resolve_order(p_grant,p_now) IS DISTINCT FROM v_order THEN RETURN NULL; END IF;
  SELECT * INTO v_review FROM public.commerce_order_reviews WHERE order_id=v_order FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO v_media FROM public.commerce_order_review_media WHERE review_id=v_review.id AND media_reference=p_media_ref FOR UPDATE;
  IF NOT FOUND OR v_media.authorizing_grant_reference<>p_grant THEN RETURN NULL; END IF;
  v_fp:=encode(sha256(convert_to(v_review.review_reference||':'||p_media_ref||':'||p_digest,'UTF8')),'hex');
  SELECT * INTO v_receipt FROM public.commerce_order_review_command_receipts
    WHERE command_kind='media_confirm' AND command_key=p_command_key;
  IF FOUND THEN
    IF v_receipt.fingerprint<>v_fp THEN RAISE EXCEPTION 'order_review_conflict' USING ERRCODE='23505'; END IF;
    RETURN v_receipt.result||jsonb_build_object('replayed',true);
  END IF;
  IF v_media.state NOT IN ('stored','confirmed') OR v_media.observed_digest<>p_digest
  THEN RAISE EXCEPTION 'order_review_conflict' USING ERRCODE='23505'; END IF;
  IF v_media.state='confirmed' THEN RETURN public.order_review_media_json(v_media)||jsonb_build_object('replayed',true); END IF;
  v_before:=public.order_review_media_json(v_media);
  IF v_media.state='stored' THEN
    UPDATE public.commerce_order_review_media SET state='confirmed',reconcile_receipt=NULL,
      reconcile_claimed_at=NULL,reconcile_state_version=NULL,state_version=state_version+1,updated_at=p_now
      WHERE id=v_media.id RETURNING * INTO v_media;
    INSERT INTO public.commerce_order_review_audit(review_id,media_id,actor_reference,action,before_state,after_state,command_fingerprint,idempotency_key,occurred_at)
    VALUES(v_review.id,v_media.id,'customer-grant','media_confirm',v_before,public.order_review_media_json(v_media),v_fp,p_command_key,p_now);
  END IF;
  INSERT INTO public.commerce_order_review_command_receipts(command_kind,command_key,fingerprint,result)
    VALUES('media_confirm',p_command_key,v_fp,public.order_review_media_json(v_media));
  RETURN public.order_review_media_json(v_media)||jsonb_build_object('replayed',false);
END $$;

CREATE FUNCTION public.order_review_moderate(p_review_ref text,p_action text,p_actor text,p_key text,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_catalog AS $$
DECLARE v_review public.commerce_order_reviews%ROWTYPE; v_receipt public.commerce_order_review_command_receipts%ROWTYPE;
  v_fp text; v_before jsonb; v_target text;
BEGIN
  IF p_review_ref IS NULL OR p_review_ref !~ '^order-review:[a-f0-9-]{36}$' OR p_action IS NULL
     OR p_action NOT IN ('publish','hide') OR p_actor IS NULL OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
     OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' OR p_now IS NULL
  THEN RAISE EXCEPTION 'order_review_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_review FROM public.commerce_order_reviews WHERE review_reference=p_review_ref FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_review.access_revoked_at IS NOT NULL THEN RETURN NULL; END IF;
  v_target:=CASE p_action WHEN 'publish' THEN 'visible' ELSE 'hidden' END;
  v_fp:=encode(sha256(convert_to(p_review_ref||':'||p_action||':'||p_actor,'UTF8')),'hex');
  SELECT * INTO v_receipt FROM public.commerce_order_review_command_receipts WHERE command_kind='moderate' AND command_key=p_key;
  IF FOUND THEN
    IF v_receipt.fingerprint<>v_fp THEN RAISE EXCEPTION 'order_review_conflict' USING ERRCODE='23505'; END IF;
    RETURN v_receipt.result||jsonb_build_object('replayed',true);
  END IF;
  v_before:=public.order_review_json(v_review);
  UPDATE public.commerce_order_reviews SET moderation=v_target,state_version=state_version+1,updated_at=p_now
    WHERE id=v_review.id RETURNING * INTO v_review;
  INSERT INTO public.commerce_order_review_audit(review_id,actor_reference,action,before_state,after_state,command_fingerprint,idempotency_key,occurred_at)
    VALUES(v_review.id,p_actor,'moderate',v_before,public.order_review_json(v_review),v_fp,p_key,p_now);
  INSERT INTO public.commerce_order_review_command_receipts(command_kind,command_key,fingerprint,result)
    VALUES('moderate',p_key,v_fp,public.order_review_json(v_review));
  RETURN public.order_review_json(v_review,false);
END $$;

CREATE FUNCTION public.order_review_revoke_access(p_review_ref text,p_actor text,p_key text,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_catalog AS $$
DECLARE v_review public.commerce_order_reviews%ROWTYPE; v_receipt public.commerce_order_review_command_receipts%ROWTYPE;
  v_fp text; v_before jsonb; v_after jsonb;
BEGIN
  IF p_review_ref IS NULL OR p_review_ref !~ '^order-review:[a-f0-9-]{36}$' OR p_actor IS NULL
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' OR p_key IS NULL
     OR p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' OR p_now IS NULL
  THEN RAISE EXCEPTION 'order_review_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_review FROM public.commerce_order_reviews WHERE review_reference=p_review_ref;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('order:'||v_review.order_id::text||'|review_effects',0));
  PERFORM pg_advisory_xact_lock(hashtextextended('order:'||v_review.order_id::text||'|review_request',0));
  PERFORM 1 FROM public.subscriber_review_access_grants WHERE order_id=v_review.order_id
    ORDER BY kind,grant_reference FOR UPDATE;
  SELECT * INTO v_review FROM public.commerce_order_reviews WHERE id=v_review.id FOR UPDATE;
  IF NOT FOUND OR v_review.review_reference<>p_review_ref THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.commerce_order_review_media WHERE review_id=v_review.id ORDER BY id FOR UPDATE;
  v_fp:=encode(sha256(convert_to(p_review_ref||':'||p_actor,'UTF8')),'hex');
  SELECT * INTO v_receipt FROM public.commerce_order_review_command_receipts WHERE command_kind='review_revoke' AND command_key=p_key;
  IF FOUND THEN
    IF v_receipt.fingerprint<>v_fp THEN RAISE EXCEPTION 'order_review_conflict' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('replayed',true);
  END IF;
  IF v_review.access_revoked_at IS NOT NULL THEN RAISE EXCEPTION 'order_review_conflict' USING ERRCODE='23505'; END IF;
  v_before:=jsonb_build_object('moderation',v_review.moderation,'activeMedia',
    (SELECT count(*) FROM public.commerce_order_review_media WHERE review_id=v_review.id AND state<>'deleted'));
  UPDATE public.subscriber_review_access_grants SET revoked_at=GREATEST(p_now,issued_at)
    WHERE order_id=v_review.order_id AND revoked_at IS NULL;
  UPDATE public.commerce_order_reviews SET access_revoked_at=GREATEST(p_now,created_at),
    state_version=state_version+1,updated_at=p_now WHERE id=v_review.id RETURNING * INTO v_review;
  UPDATE public.commerce_order_review_media SET state='cleanup_pending',
    next_attempt_at=GREATEST(p_now,COALESCE(writer_lease_expires_at,p_now)),
    reconcile_receipt=NULL,reconcile_claimed_at=NULL,
    reconcile_state_version=NULL,state_version=state_version+1,updated_at=p_now
    WHERE review_id=v_review.id AND state<>'deleted';
  v_after:=jsonb_build_object('revoked',true,'cleanupPending',
    (SELECT count(*) FROM public.commerce_order_review_media WHERE review_id=v_review.id AND state='cleanup_pending'));
  INSERT INTO public.commerce_order_review_audit(review_id,actor_reference,action,before_state,after_state,command_fingerprint,idempotency_key,occurred_at)
    VALUES(v_review.id,p_actor,'review_revoke',v_before,v_after,v_fp,p_key,p_now);
  INSERT INTO public.commerce_order_review_command_receipts(command_kind,command_key,fingerprint,result)
    VALUES('review_revoke',p_key,v_fp,jsonb_build_object('ok',true));
  RETURN jsonb_build_object('replayed',false);
END $$;

CREATE FUNCTION public.order_review_admin_read(p_actor text,p_review_ref text,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_catalog AS $$
DECLARE v_review public.commerce_order_reviews%ROWTYPE;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
     OR p_review_ref IS NULL OR p_now IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_review FROM public.commerce_order_reviews
    WHERE review_reference=p_review_ref AND access_revoked_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('review',public.order_review_json(v_review),'media',
    (SELECT COALESCE(jsonb_agg(public.order_review_media_json(m) ORDER BY m.created_at,m.id),'[]'::jsonb)
      FROM public.commerce_order_review_media m WHERE m.review_id=v_review.id AND m.state<>'deleted'));
END $$;

CREATE FUNCTION public.order_review_admin_list(p_actor text,p_cursor text,p_limit integer,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_catalog AS $$
DECLARE v_time timestamptz; v_id uuid; v_items jsonb; v_last_time timestamptz; v_last_id uuid;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_now IS NULL THEN RETURN NULL; END IF;
  IF p_cursor IS NOT NULL THEN
    BEGIN v_time:=split_part(p_cursor,'|',1)::timestamptz; v_id:=split_part(p_cursor,'|',2)::uuid;
    EXCEPTION WHEN OTHERS THEN RETURN NULL; END;
  END IF;
  WITH page AS (SELECT * FROM public.commerce_order_reviews r
    WHERE r.access_revoked_at IS NULL AND (p_cursor IS NULL OR (r.created_at,r.id)<(v_time,v_id))
    ORDER BY r.created_at DESC,r.id DESC LIMIT p_limit)
  SELECT COALESCE(jsonb_agg(public.order_review_json(page) ORDER BY created_at DESC,id DESC),'[]'::jsonb)
    INTO v_items FROM page;
  SELECT created_at,id INTO v_last_time,v_last_id FROM public.commerce_order_reviews r
    WHERE r.access_revoked_at IS NULL AND (p_cursor IS NULL OR (r.created_at,r.id)<(v_time,v_id))
    ORDER BY created_at DESC,id DESC OFFSET GREATEST(p_limit-1,0) LIMIT 1;
  RETURN jsonb_strip_nulls(jsonb_build_object('items',v_items,'nextCursor',
    CASE WHEN v_last_id IS NULL THEN NULL ELSE v_last_time::text||'|'||v_last_id::text END));
END $$;

CREATE FUNCTION public.order_review_read_media(p_grant text,p_media_ref text,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_catalog AS $$
DECLARE v_order uuid; v_media public.commerce_order_review_media%ROWTYPE;
BEGIN
  v_order:=public.order_review_resolve_order(p_grant,p_now); IF v_order IS NULL THEN RETURN NULL; END IF;
  SELECT m.* INTO v_media FROM public.commerce_order_review_media m
    JOIN public.commerce_order_reviews r ON r.id=m.review_id
    WHERE r.order_id=v_order AND m.media_reference=p_media_ref
      AND m.authorizing_grant_reference=p_grant AND m.state='confirmed';
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('media',public.order_review_media_json(v_media),'objectKey',v_media.object_key);
END $$;

CREATE FUNCTION public.order_review_admit_media_upload(p_capability text,p_type text,p_length integer,p_writer text,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_catalog AS $$
DECLARE v_media public.commerce_order_review_media%ROWTYPE; v_order uuid; v_grant text;
BEGIN
  IF p_capability IS NULL OR p_capability !~ '^[a-f0-9]{64}$' OR p_type IS NULL
     OR p_type NOT IN ('image/jpeg','image/png','image/webp') OR p_length IS NULL
     OR p_length NOT BETWEEN 1 AND 20971520 OR p_writer IS NULL
     OR p_writer !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' OR p_now IS NULL
  THEN RAISE EXCEPTION 'order_review_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_media FROM public.commerce_order_review_media WHERE capability_digest=p_capability;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT order_id INTO v_order FROM public.commerce_order_reviews WHERE id=v_media.review_id;
  IF v_media.declared_content_type<>p_type OR v_media.declared_byte_length<>p_length
  THEN RAISE EXCEPTION 'order_review_conflict' USING ERRCODE='23505'; END IF;
  v_grant:=v_media.authorizing_grant_reference;
  PERFORM 1 FROM public.subscriber_review_access_grants
    WHERE grant_reference=v_grant AND kind=v_media.authorizing_grant_kind FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF public.order_review_resolve_order(v_grant,p_now) IS DISTINCT FROM v_order THEN RETURN NULL; END IF;
  SELECT * INTO v_media FROM public.commerce_order_review_media WHERE capability_digest=p_capability FOR UPDATE;
  IF v_media.state IN ('stored','confirmed') AND v_media.capability_consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('kind','complete','media',public.order_review_media_json(v_media));
  END IF;
  IF v_media.state<>'pending' OR v_media.capability_consumed_at IS NOT NULL OR v_media.capability_expires_at<=p_now THEN RETURN NULL; END IF;
  IF v_media.writer_reference IS NOT NULL OR v_media.temp_key IS NOT NULL OR v_media.reconcile_receipt IS NOT NULL
  THEN RAISE EXCEPTION 'order_review_conflict' USING ERRCODE='23505'; END IF;
  UPDATE public.commerce_order_review_media SET writer_reference=p_writer,
    writer_lease_version=writer_lease_version+1,writer_lease_expires_at=p_now+interval '2 minutes',
    temp_key='tmp/'||encode(sha256(convert_to(p_writer,'UTF8')),'hex')||'-part',reconcile_receipt=NULL,
    reconcile_claimed_at=NULL,reconcile_state_version=NULL,state_version=state_version+1,updated_at=p_now
    WHERE id=v_media.id RETURNING * INTO v_media;
  RETURN jsonb_build_object('kind','lease','media',public.order_review_media_json(v_media),
    'leaseVersion',v_media.writer_lease_version,'leaseExpiresAt',v_media.writer_lease_expires_at,
    'objectKey',v_media.object_key,'declaredContentType',v_media.declared_content_type,
    'declaredByteLength',v_media.declared_byte_length);
END $$;

CREATE FUNCTION public.order_review_lock_media_finalize(p_capability text,p_writer text,p_lease bigint,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_catalog AS $$
DECLARE v_media public.commerce_order_review_media%ROWTYPE; v_order uuid; v_grant text;
BEGIN
  IF p_capability IS NULL OR p_writer IS NULL OR p_lease IS NULL OR p_now IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_media FROM public.commerce_order_review_media WHERE capability_digest=p_capability;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT order_id INTO v_order FROM public.commerce_order_reviews WHERE id=v_media.review_id;
  v_grant:=v_media.authorizing_grant_reference;
  PERFORM 1 FROM public.subscriber_review_access_grants
    WHERE grant_reference=v_grant AND kind=v_media.authorizing_grant_kind FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF public.order_review_resolve_order(v_grant,p_now) IS DISTINCT FROM v_order THEN RETURN NULL; END IF;
  SELECT * INTO v_media FROM public.commerce_order_review_media WHERE id=v_media.id FOR UPDATE;
  IF v_media.state<>'pending' OR v_media.capability_consumed_at IS NOT NULL
     OR v_media.writer_reference IS DISTINCT FROM p_writer OR v_media.writer_lease_version<>p_lease
     OR v_media.writer_lease_expires_at<=p_now THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('media',public.order_review_media_json(v_media));
END $$;

CREATE FUNCTION public.order_review_record_media_stored(p_capability text,p_writer text,p_lease bigint,p_digest text,p_length integer,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_catalog AS $$
DECLARE v_media public.commerce_order_review_media%ROWTYPE; v_before jsonb;
BEGIN
  IF p_capability IS NULL OR p_writer IS NULL OR p_lease IS NULL OR p_digest IS NULL
     OR p_length IS NULL OR p_now IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_media FROM public.commerce_order_review_media WHERE capability_digest=p_capability FOR UPDATE;
  IF NOT FOUND OR v_media.state<>'pending' OR v_media.writer_reference IS DISTINCT FROM p_writer
     OR v_media.writer_lease_version<>p_lease OR v_media.writer_lease_expires_at<=p_now
     OR p_length<>v_media.declared_byte_length OR p_digest !~ '^[a-f0-9]{64}$' THEN RETURN NULL; END IF;
  v_before:=public.order_review_media_json(v_media);
  UPDATE public.commerce_order_review_media SET state='stored',observed_content_type=declared_content_type,
    observed_byte_length=p_length,observed_digest=p_digest,capability_consumed_at=p_now,
    writer_reference=NULL,writer_lease_expires_at=NULL,temp_key=NULL,reconcile_receipt=NULL,
    reconcile_claimed_at=NULL,reconcile_state_version=NULL,state_version=state_version+1,updated_at=p_now
    WHERE id=v_media.id RETURNING * INTO v_media;
  INSERT INTO public.commerce_order_review_audit(review_id,media_id,actor_reference,action,before_state,after_state,command_fingerprint,occurred_at)
    VALUES(v_media.review_id,v_media.id,'direct-writer','media_stored',v_before,public.order_review_media_json(v_media),p_digest,p_now);
  RETURN public.order_review_media_json(v_media);
END $$;

CREATE FUNCTION public.order_review_abort_media_upload(p_capability text,p_writer text,p_lease bigint,p_reason text,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_catalog AS $$
DECLARE v_media public.commerce_order_review_media%ROWTYPE;
BEGIN
  IF p_capability IS NULL OR p_writer IS NULL OR p_lease IS NULL OR p_reason IS NULL OR p_now IS NULL
  THEN RETURN jsonb_build_object('reconciled',0); END IF;
  SELECT * INTO v_media FROM public.commerce_order_review_media WHERE capability_digest=p_capability FOR UPDATE;
  IF NOT FOUND OR v_media.state<>'pending' OR v_media.writer_reference IS DISTINCT FROM p_writer
     OR v_media.writer_lease_version<>p_lease THEN RETURN jsonb_build_object('reconciled',0); END IF;
  IF p_reason='object_absent' THEN
    UPDATE public.commerce_order_review_media SET writer_reference=NULL,writer_lease_expires_at=NULL,temp_key=NULL,
      next_attempt_at=NULL,reconcile_receipt=NULL,reconcile_claimed_at=NULL,reconcile_state_version=NULL,
      state_version=state_version+1,updated_at=p_now WHERE id=v_media.id;
  ELSE
    UPDATE public.commerce_order_review_media SET state='cleanup_pending',writer_reference=NULL,
      writer_lease_expires_at=NULL,next_attempt_at=p_now,reconcile_receipt=NULL,reconcile_claimed_at=NULL,
      reconcile_state_version=NULL,state_version=state_version+1,updated_at=p_now WHERE id=v_media.id;
  END IF;
  RETURN jsonb_build_object('reconciled',1);
END $$;

CREATE FUNCTION public.order_review_admin_read_media(p_actor text,p_media_ref text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_catalog AS $$
DECLARE v_media public.commerce_order_review_media%ROWTYPE;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' OR p_media_ref IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_media FROM public.commerce_order_review_media
    WHERE media_reference=p_media_ref AND state IN ('stored','confirmed');
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('media',public.order_review_media_json(v_media),'objectKey',v_media.object_key);
END $$;

CREATE FUNCTION public.order_review_admin_prepare_media_delete(p_actor text,p_media_ref text,p_key text,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_catalog AS $$
DECLARE v_media public.commerce_order_review_media%ROWTYPE; v_review public.commerce_order_reviews%ROWTYPE;
  v_receipt public.commerce_order_review_command_receipts%ROWTYPE; v_fp text; v_result jsonb; v_before jsonb;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' OR p_media_ref IS NULL
     OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' OR p_now IS NULL
  THEN RAISE EXCEPTION 'order_review_invalid' USING ERRCODE='22023'; END IF;
  SELECT r.* INTO v_review FROM public.commerce_order_reviews r JOIN public.commerce_order_review_media m ON m.review_id=r.id
    WHERE m.media_reference=p_media_ref FOR UPDATE OF r;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO v_media FROM public.commerce_order_review_media WHERE media_reference=p_media_ref FOR UPDATE;
  v_fp:=encode(sha256(convert_to(v_review.review_reference||':'||p_media_ref||':'||p_actor,'UTF8')),'hex');
  SELECT * INTO v_receipt FROM public.commerce_order_review_command_receipts WHERE command_kind='media_delete' AND command_key=p_key;
  IF FOUND THEN
    IF v_receipt.fingerprint<>v_fp THEN RAISE EXCEPTION 'order_review_conflict' USING ERRCODE='23505'; END IF;
    RETURN v_receipt.result||jsonb_build_object('replayed',true);
  END IF;
  IF v_media.state='deleted' THEN RETURN NULL; END IF;
  IF v_media.state='cleanup_pending' THEN RAISE EXCEPTION 'order_review_conflict' USING ERRCODE='23505'; END IF;
  v_before:=public.order_review_media_json(v_media);
  UPDATE public.commerce_order_review_media SET state='cleanup_pending',cleanup_receipt='cleanup:'||gen_random_uuid()::text,
    next_attempt_at=GREATEST(p_now,COALESCE(writer_lease_expires_at,p_now)),reconcile_receipt=NULL,
    reconcile_claimed_at=NULL,reconcile_state_version=NULL,state_version=state_version+1,updated_at=p_now
    WHERE id=v_media.id RETURNING * INTO v_media;
  v_result:=jsonb_strip_nulls(jsonb_build_object('media',public.order_review_media_json(v_media),'objectKey',v_media.object_key,
    'tempKey',v_media.temp_key,'cleanupReceipt',v_media.cleanup_receipt));
  INSERT INTO public.commerce_order_review_audit(review_id,media_id,actor_reference,action,before_state,after_state,command_fingerprint,idempotency_key,occurred_at)
    VALUES(v_review.id,v_media.id,p_actor,'media_delete',v_before,public.order_review_media_json(v_media),v_fp,p_key,p_now);
  INSERT INTO public.commerce_order_review_command_receipts(command_kind,command_key,fingerprint,result)
    VALUES('media_delete',p_key,v_fp,v_result);
  RETURN v_result||jsonb_build_object('replayed',false);
END $$;

CREATE FUNCTION public.order_review_admin_complete_media_delete(p_actor text,p_cleanup text,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_catalog AS $$
DECLARE v_media public.commerce_order_review_media%ROWTYPE;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
     OR p_cleanup IS NULL OR p_now IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_media FROM public.commerce_order_review_media WHERE cleanup_receipt=p_cleanup FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_media.state='deleted' THEN RETURN jsonb_build_object('replayed',true); END IF;
  IF v_media.state<>'cleanup_pending' THEN RETURN NULL; END IF;
  IF v_media.writer_lease_expires_at IS NOT NULL AND v_media.writer_lease_expires_at>p_now THEN RETURN NULL; END IF;
  UPDATE public.commerce_order_review_media SET state='deleted',next_attempt_at=NULL,temp_key=NULL,
    writer_reference=NULL,writer_lease_expires_at=NULL,
    reconcile_receipt=NULL,reconcile_claimed_at=NULL,reconcile_state_version=NULL,
    state_version=state_version+1,updated_at=p_now WHERE id=v_media.id;
  RETURN jsonb_build_object('replayed',false);
END $$;

CREATE FUNCTION public.order_review_claim_media_reconcile(p_limit integer,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_catalog AS $$
DECLARE v_media public.commerce_order_review_media%ROWTYPE; v_tasks jsonb:='[]'::jsonb; v_receipt text;
  v_order uuid;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_now IS NULL
  THEN RAISE EXCEPTION 'order_review_invalid' USING ERRCODE='22023'; END IF;
  FOR v_media IN SELECT * FROM public.commerce_order_review_media
    WHERE ((state='cleanup_pending' AND next_attempt_at<=p_now)
       OR (state='pending' AND ((writer_reference IS NOT NULL AND writer_lease_expires_at<=p_now)
         OR (writer_reference IS NULL AND capability_expires_at<=p_now))))
      AND (reconcile_claimed_at IS NULL OR reconcile_claimed_at<=p_now-interval '5 minutes')
    ORDER BY COALESCE(next_attempt_at,writer_lease_expires_at,capability_expires_at),id
    FOR UPDATE SKIP LOCKED LIMIT p_limit
  LOOP
    IF v_media.state='pending' AND NOT
       (v_media.writer_reference IS NULL AND v_media.capability_expires_at<=p_now) THEN
      SELECT order_id INTO v_order FROM public.commerce_order_reviews WHERE id=v_media.review_id;
      IF public.order_review_resolve_order(v_media.authorizing_grant_reference,p_now) IS DISTINCT FROM v_order THEN
        UPDATE public.commerce_order_review_media SET state='cleanup_pending',writer_reference=NULL,
          writer_lease_expires_at=NULL,next_attempt_at=p_now,state_version=state_version+1,updated_at=p_now
          WHERE id=v_media.id RETURNING * INTO v_media;
      END IF;
    END IF;
    v_receipt:='reconcile:'||gen_random_uuid()::text;
    UPDATE public.commerce_order_review_media SET reconcile_receipt=v_receipt,reconcile_claimed_at=p_now,
      reconcile_state_version=state_version WHERE id=v_media.id;
    v_tasks:=v_tasks||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('receipt',v_receipt,
      'kind',CASE WHEN v_media.state='cleanup_pending' OR v_media.writer_reference IS NULL THEN 'delete' ELSE 'finalize' END,
      'objectKey',v_media.object_key,'tempKey',v_media.temp_key,
      'expectedDeclaredContentType',v_media.declared_content_type,'expectedDeclaredByteLength',v_media.declared_byte_length)));
  END LOOP;
  RETURN jsonb_build_object('tasks',v_tasks);
END $$;

CREATE FUNCTION public.order_review_complete_media_reconcile(p_receipt text,p_outcome text,p_type text,p_length integer,p_digest text,p_reason text,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_catalog AS $$
DECLARE v_media public.commerce_order_review_media%ROWTYPE; v_before jsonb; v_order uuid;
BEGIN
  IF p_receipt IS NULL OR p_outcome IS NULL OR p_now IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_media FROM public.commerce_order_review_media
    WHERE reconcile_receipt=p_receipt AND reconcile_state_version=state_version;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_outcome='stored' THEN
    SELECT order_id INTO v_order FROM public.commerce_order_reviews WHERE id=v_media.review_id;
    PERFORM 1 FROM public.subscriber_review_access_grants
      WHERE grant_reference=v_media.authorizing_grant_reference AND kind=v_media.authorizing_grant_kind FOR UPDATE;
    IF NOT FOUND OR public.order_review_resolve_order(v_media.authorizing_grant_reference,p_now) IS DISTINCT FROM v_order THEN
      SELECT * INTO v_media FROM public.commerce_order_review_media
        WHERE reconcile_receipt=p_receipt AND reconcile_state_version=state_version FOR UPDATE;
      IF NOT FOUND THEN RETURN NULL; END IF;
      UPDATE public.commerce_order_review_media SET state='cleanup_pending',writer_reference=NULL,
        writer_lease_expires_at=NULL,next_attempt_at=p_now,reconcile_receipt=NULL,reconcile_claimed_at=NULL,
        reconcile_state_version=NULL,state_version=state_version+1,updated_at=p_now WHERE id=v_media.id;
      RETURN jsonb_build_object('ok',true);
    END IF;
  END IF;
  SELECT * INTO v_media FROM public.commerce_order_review_media
    WHERE reconcile_receipt=p_receipt AND reconcile_state_version=state_version FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF; v_before:=public.order_review_media_json(v_media);
  IF p_outcome='stored' AND v_media.state='pending' AND p_type=v_media.declared_content_type
     AND p_length=v_media.declared_byte_length AND p_digest~'^[a-f0-9]{64}$' THEN
    UPDATE public.commerce_order_review_media SET state='stored',observed_content_type=p_type,observed_byte_length=p_length,
      observed_digest=p_digest,capability_consumed_at=p_now,writer_reference=NULL,writer_lease_expires_at=NULL,temp_key=NULL,
      reconcile_receipt=NULL,reconcile_claimed_at=NULL,reconcile_state_version=NULL,
      state_version=state_version+1,updated_at=p_now WHERE id=v_media.id RETURNING * INTO v_media;
    INSERT INTO public.commerce_order_review_audit(review_id,media_id,actor_reference,action,before_state,after_state,command_fingerprint,occurred_at)
      VALUES(v_media.review_id,v_media.id,'reconciler','media_stored',v_before,public.order_review_media_json(v_media),p_digest,p_now);
  ELSIF p_outcome='deleted' AND (v_media.state='cleanup_pending' OR
        (v_media.state='pending' AND v_media.writer_reference IS NULL AND v_media.capability_expires_at<=p_now)) THEN
    UPDATE public.commerce_order_review_media SET state='deleted',next_attempt_at=NULL,temp_key=NULL,
      writer_reference=NULL,writer_lease_expires_at=NULL,
      reconcile_receipt=NULL,reconcile_claimed_at=NULL,reconcile_state_version=NULL,
      state_version=state_version+1,updated_at=p_now WHERE id=v_media.id RETURNING * INTO v_media;
    INSERT INTO public.commerce_order_review_audit(review_id,media_id,actor_reference,action,before_state,after_state,command_fingerprint,occurred_at)
      VALUES(v_media.review_id,v_media.id,'reconciler','media_cleanup',v_before,public.order_review_media_json(v_media),repeat('0',64),p_now);
  ELSIF p_outcome='retry' AND p_reason='object_absent' AND v_media.state='pending' THEN
    UPDATE public.commerce_order_review_media SET writer_reference=NULL,writer_lease_expires_at=NULL,temp_key=NULL,
      next_attempt_at=NULL,retry_count=retry_count+1,reconcile_receipt=NULL,reconcile_claimed_at=NULL,
      reconcile_state_version=NULL,state_version=state_version+1,updated_at=p_now WHERE id=v_media.id;
  ELSIF p_outcome='retry' AND p_reason IS NOT NULL AND char_length(p_reason) BETWEEN 1 AND 128 THEN
    UPDATE public.commerce_order_review_media SET state='cleanup_pending',writer_reference=NULL,
      writer_lease_expires_at=NULL,next_attempt_at=p_now+make_interval(secs=>LEAST(3600,30*(retry_count+1))),
      retry_count=retry_count+1,reconcile_receipt=NULL,reconcile_claimed_at=NULL,reconcile_state_version=NULL,
      state_version=state_version+1,updated_at=p_now WHERE id=v_media.id;
  ELSE RAISE EXCEPTION 'order_review_conflict' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('ok',true);
END $$;

-- Function privileges are closed only after every exact signature exists.
REVOKE ALL ON FUNCTION public.order_review_refuse_audit_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_review_resolve_order(text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_review_json(public.commerce_order_reviews,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_review_media_json(public.commerce_order_review_media) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_review_read(text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_review_submit(text,integer,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_review_create_media_intent(text,text,integer,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_review_confirm_media(text,text,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_review_moderate(text,text,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_review_revoke_access(text,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_review_admin_read(text,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_review_admin_list(text,text,integer,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_review_read_media(text,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_review_admit_media_upload(text,text,integer,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_review_lock_media_finalize(text,text,bigint,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_review_record_media_stored(text,text,bigint,text,integer,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_review_abort_media_upload(text,text,bigint,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_review_admin_read_media(text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_review_admin_prepare_media_delete(text,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_review_admin_complete_media_delete(text,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_review_claim_media_reconcile(integer,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_review_complete_media_reconcile(text,text,text,integer,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
