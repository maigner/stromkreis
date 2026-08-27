\restrict dbmate

-- Dumped from database version 17.10
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: refresh_measurement_daily(bigint, date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_measurement_daily(p_tenant bigint, p_from date, p_to date) RETURNS integer
    LANGUAGE plpgsql
    AS $$
declare
    n integer;
begin
    delete from measurement_daily where tenant_id = p_tenant and day between p_from and p_to;
    insert into measurement_daily (tenant_id, measurement_point_id, meter_code_id, day, kwh, intervals, nonzero_intervals)
    select tenant_id, measurement_point_id, meter_code_id,
        (measured_at at time zone 'Europe/Vienna')::date,
        sum(value), count(*)::integer, count(*) filter (where value > 0)::integer
    from measurement
    where tenant_id = p_tenant
        and measured_at >= p_from::timestamp at time zone 'Europe/Vienna'
        and measured_at < (p_to + 1)::timestamp at time zone 'Europe/Vienna'
    group by 1, 2, 3, 4;
    get diagnostics n = row_count;
    return n;
end
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    new.updated_at := now();
    return new;
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: battery_site; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battery_site (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    member_id bigint,
    name text NOT NULL,
    inverter_profile text NOT NULL,
    token_hash text NOT NULL,
    last_seen_at timestamp with time zone,
    status jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    latitude double precision,
    longitude double precision,
    address text,
    provision_code text,
    provision_expires_at timestamp with time zone,
    provisioned_at timestamp with time zone,
    setup_phase text DEFAULT 'neu'::text NOT NULL,
    setup_message text,
    setup_phase_at timestamp with time zone,
    measurement_point_id bigint,
    capacity_kwh numeric(8,2),
    pv_kwp numeric(8,2),
    CONSTRAINT battery_site_provision_code_format CHECK (((provision_code IS NULL) OR (provision_code ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}$'::text)))
);


--
-- Name: battery_site_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.battery_site ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.battery_site_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: eegfaktura_oidc_token; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.eegfaktura_oidc_token (
    tenant_id bigint NOT NULL,
    member_id bigint NOT NULL,
    issuer text NOT NULL,
    client_id text NOT NULL,
    refresh_token_enc text NOT NULL,
    scope text,
    refreshed_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: eegfaktura_source; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.eegfaktura_source (
    tenant_id bigint NOT NULL,
    rc_number text NOT NULL,
    base_url text DEFAULT 'https://eegfaktura.at'::text NOT NULL,
    auth_mode text NOT NULL,
    token_url text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    community_id text,
    CONSTRAINT eegfaktura_source_auth_mode_check CHECK ((auth_mode = ANY (ARRAY['basic'::text, 'client_credentials'::text, 'oidc'::text]))),
    CONSTRAINT eegfaktura_source_community_id_check CHECK ((community_id = upper(community_id))),
    CONSTRAINT eegfaktura_source_rc_number_check CHECK ((rc_number = upper(rc_number)))
);


--
-- Name: eegfaktura_sync_job; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.eegfaktura_sync_job (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    phase text DEFAULT 'queued'::text NOT NULL,
    full_import boolean DEFAULT false NOT NULL,
    progress jsonb DEFAULT '{}'::jsonb NOT NULL,
    error text,
    requested_by bigint,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    finished_at timestamp with time zone,
    CONSTRAINT eegfaktura_sync_job_phase_check CHECK ((phase = ANY (ARRAY['queued'::text, 'masterdata'::text, 'energy'::text, 'done'::text, 'error'::text])))
);


--
-- Name: eegfaktura_sync_job_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.eegfaktura_sync_job ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.eegfaktura_sync_job_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: forecast_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.forecast_run (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    model_version text NOT NULL,
    data_until date NOT NULL,
    horizon_start timestamp with time zone NOT NULL,
    horizon_end timestamp with time zone NOT NULL,
    training_intervals integer DEFAULT 0 NOT NULL,
    parameters jsonb
);


--
-- Name: forecast_run_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.forecast_run ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.forecast_run_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: forecast_value; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.forecast_value (
    tenant_id bigint NOT NULL,
    run_id bigint NOT NULL,
    "time" timestamp with time zone NOT NULL,
    consumption_kwh double precision NOT NULL,
    consumption_kwh_p10 double precision,
    consumption_kwh_p90 double precision,
    generation_kwh double precision NOT NULL,
    generation_kwh_p10 double precision,
    generation_kwh_p90 double precision,
    self_coverage_kwh double precision NOT NULL,
    self_coverage_kwh_p10 double precision,
    self_coverage_kwh_p90 double precision,
    surplus_kwh double precision NOT NULL,
    surplus_kwh_p10 double precision,
    surplus_kwh_p90 double precision,
    n_consumption_points integer NOT NULL,
    n_generation_points integer NOT NULL
);


--
-- Name: login_token; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_token (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    member_id bigint NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: login_token_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.login_token ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.login_token_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: measurement; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.measurement (
    tenant_id bigint NOT NULL,
    measurement_point_id bigint NOT NULL,
    meter_code_id bigint NOT NULL,
    measured_at timestamp with time zone NOT NULL,
    value numeric(19,10) NOT NULL,
    quality smallint,
    CONSTRAINT measurement_quality_check CHECK (((quality >= 0) AND (quality <= 3)))
);


--
-- Name: measurement_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.measurement_daily (
    tenant_id bigint NOT NULL,
    measurement_point_id bigint NOT NULL,
    meter_code_id bigint NOT NULL,
    day date NOT NULL,
    kwh numeric(14,4) NOT NULL,
    intervals integer NOT NULL,
    nonzero_intervals integer NOT NULL
);


--
-- Name: TABLE measurement_daily; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.measurement_daily IS 'Tagessummen (kWh) je Zaehlpunkt und Kategorie, lokaler Tag Europe/Vienna; aus measurement per refresh_measurement_daily()';


--
-- Name: COLUMN measurement_daily.intervals; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.measurement_daily.intervals IS 'Anzahl 15-Minuten-Werte des Tages (96 = vollstaendig)';


--
-- Name: COLUMN measurement_daily.nonzero_intervals; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.measurement_daily.nonzero_intervals IS 'davon Werte > 0 (Teillieferungen erkennen)';


--
-- Name: measurement_point; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.measurement_point (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    member_id bigint,
    metering_point text NOT NULL,
    direction text NOT NULL,
    label text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT measurement_point_direction_check CHECK ((direction = ANY (ARRAY['consumption'::text, 'generation'::text])))
);


--
-- Name: measurement_point_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.measurement_point ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.measurement_point_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: member; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.member (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    name text NOT NULL,
    email text,
    role text DEFAULT 'member'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    oidc_sub text,
    participant_number text,
    address text,
    eegfaktura_participant_id text,
    latitude double precision,
    longitude double precision,
    geocoded_address text,
    geocoded_at timestamp with time zone,
    CONSTRAINT member_operator_has_email CHECK (((role <> 'operator'::text) OR (email IS NOT NULL))),
    CONSTRAINT member_role_check CHECK ((role = ANY (ARRAY['member'::text, 'board'::text, 'operator'::text])))
);


--
-- Name: COLUMN member.oidc_sub; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.member.oidc_sub IS 'Keycloak-Subject der EEG-Faktura-Identitaet, beim ersten OIDC-Login gesetzt';


--
-- Name: COLUMN member.geocoded_address; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.member.geocoded_address IS 'Adresse, auf die sich latitude/longitude beziehen; weicht sie von address ab, geokodiert der Worker neu';


--
-- Name: member_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.member ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.member_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: meter_code; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meter_code (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    description text NOT NULL,
    unit text NOT NULL,
    kind text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT meter_code_kind_check CHECK ((kind = ANY (ARRAY['total_consumption'::text, 'production_share'::text, 'self_use'::text, 'total_production'::text, 'overshoot'::text])))
);


--
-- Name: meter_code_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.meter_code ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.meter_code_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    member_id bigint NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: session_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.session ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.session_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: tenant; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant (
    id bigint NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_slug_check CHECK ((slug ~ '^[a-z0-9-]+$'::text))
);


--
-- Name: tenant_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.tenant ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.tenant_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: weather; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.weather (
    tenant_id bigint NOT NULL,
    "time" timestamp with time zone NOT NULL,
    temperature_2m double precision NOT NULL,
    cloud_cover double precision NOT NULL,
    rain double precision NOT NULL,
    snowfall double precision NOT NULL,
    snow_depth double precision NOT NULL,
    cloud_cover_low double precision NOT NULL,
    cloud_cover_mid double precision NOT NULL,
    cloud_cover_high double precision NOT NULL,
    relative_humidity_2m double precision NOT NULL,
    dew_point_2m double precision NOT NULL,
    shortwave_radiation double precision,
    direct_radiation double precision,
    diffuse_radiation double precision,
    direct_normal_irradiance double precision,
    sunshine_duration double precision,
    wind_speed_10m double precision,
    precipitation double precision,
    apparent_temperature double precision,
    snow_depth_water_equivalent double precision
);


--
-- Name: battery_site battery_site_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battery_site
    ADD CONSTRAINT battery_site_pkey PRIMARY KEY (id);


--
-- Name: battery_site battery_site_provision_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battery_site
    ADD CONSTRAINT battery_site_provision_code_key UNIQUE (provision_code);


--
-- Name: battery_site battery_site_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battery_site
    ADD CONSTRAINT battery_site_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: battery_site battery_site_tenant_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battery_site
    ADD CONSTRAINT battery_site_tenant_id_name_key UNIQUE (tenant_id, name);


--
-- Name: battery_site battery_site_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battery_site
    ADD CONSTRAINT battery_site_token_hash_key UNIQUE (token_hash);


--
-- Name: eegfaktura_oidc_token eegfaktura_oidc_token_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eegfaktura_oidc_token
    ADD CONSTRAINT eegfaktura_oidc_token_pkey PRIMARY KEY (tenant_id);


--
-- Name: eegfaktura_source eegfaktura_source_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eegfaktura_source
    ADD CONSTRAINT eegfaktura_source_pkey PRIMARY KEY (tenant_id);


--
-- Name: eegfaktura_sync_job eegfaktura_sync_job_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eegfaktura_sync_job
    ADD CONSTRAINT eegfaktura_sync_job_pkey PRIMARY KEY (id);


--
-- Name: forecast_run forecast_run_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forecast_run
    ADD CONSTRAINT forecast_run_pkey PRIMARY KEY (id);


--
-- Name: forecast_run forecast_run_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forecast_run
    ADD CONSTRAINT forecast_run_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: forecast_value forecast_value_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forecast_value
    ADD CONSTRAINT forecast_value_pkey PRIMARY KEY (tenant_id, run_id, "time");


--
-- Name: login_token login_token_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_token
    ADD CONSTRAINT login_token_pkey PRIMARY KEY (id);


--
-- Name: login_token login_token_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_token
    ADD CONSTRAINT login_token_token_hash_key UNIQUE (token_hash);


--
-- Name: measurement_daily measurement_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.measurement_daily
    ADD CONSTRAINT measurement_daily_pkey PRIMARY KEY (tenant_id, measurement_point_id, meter_code_id, day);


--
-- Name: measurement measurement_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.measurement
    ADD CONSTRAINT measurement_pkey PRIMARY KEY (tenant_id, measurement_point_id, meter_code_id, measured_at);


--
-- Name: measurement_point measurement_point_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.measurement_point
    ADD CONSTRAINT measurement_point_pkey PRIMARY KEY (id);


--
-- Name: measurement_point measurement_point_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.measurement_point
    ADD CONSTRAINT measurement_point_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: measurement_point measurement_point_tenant_id_metering_point_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.measurement_point
    ADD CONSTRAINT measurement_point_tenant_id_metering_point_key UNIQUE (tenant_id, metering_point);


--
-- Name: member member_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member
    ADD CONSTRAINT member_pkey PRIMARY KEY (id);


--
-- Name: member member_tenant_id_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member
    ADD CONSTRAINT member_tenant_id_email_key UNIQUE (tenant_id, email);


--
-- Name: member member_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member
    ADD CONSTRAINT member_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: meter_code meter_code_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meter_code
    ADD CONSTRAINT meter_code_pkey PRIMARY KEY (id);


--
-- Name: meter_code meter_code_tenant_id_description_unit_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meter_code
    ADD CONSTRAINT meter_code_tenant_id_description_unit_key UNIQUE (tenant_id, description, unit);


--
-- Name: meter_code meter_code_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meter_code
    ADD CONSTRAINT meter_code_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: session session_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_token_hash_key UNIQUE (token_hash);


--
-- Name: tenant tenant_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant
    ADD CONSTRAINT tenant_pkey PRIMARY KEY (id);


--
-- Name: tenant tenant_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant
    ADD CONSTRAINT tenant_slug_key UNIQUE (slug);


--
-- Name: weather weather_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weather
    ADD CONSTRAINT weather_pkey PRIMARY KEY (tenant_id, "time");


--
-- Name: battery_site_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX battery_site_tenant_idx ON public.battery_site USING btree (tenant_id);


--
-- Name: eegfaktura_sync_job_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX eegfaktura_sync_job_queue_idx ON public.eegfaktura_sync_job USING btree (requested_at) WHERE (phase = ANY (ARRAY['queued'::text, 'masterdata'::text, 'energy'::text]));


--
-- Name: eegfaktura_sync_job_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX eegfaktura_sync_job_tenant_idx ON public.eegfaktura_sync_job USING btree (tenant_id, requested_at DESC);


--
-- Name: forecast_run_tenant_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX forecast_run_tenant_created_idx ON public.forecast_run USING btree (tenant_id, created_at DESC);


--
-- Name: login_token_member_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX login_token_member_idx ON public.login_token USING btree (tenant_id, member_id);


--
-- Name: measurement_daily_tenant_day_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX measurement_daily_tenant_day_idx ON public.measurement_daily USING btree (tenant_id, day);


--
-- Name: measurement_point_member_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX measurement_point_member_idx ON public.measurement_point USING btree (tenant_id, member_id);


--
-- Name: measurement_point_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX measurement_point_tenant_idx ON public.measurement_point USING btree (tenant_id);


--
-- Name: measurement_tenant_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX measurement_tenant_time_idx ON public.measurement USING btree (tenant_id, measured_at);


--
-- Name: member_eegfaktura_participant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX member_eegfaktura_participant_idx ON public.member USING btree (tenant_id, eegfaktura_participant_id) WHERE (eegfaktura_participant_id IS NOT NULL);


--
-- Name: member_oidc_sub_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX member_oidc_sub_idx ON public.member USING btree (oidc_sub) WHERE (oidc_sub IS NOT NULL);


--
-- Name: member_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX member_tenant_idx ON public.member USING btree (tenant_id);


--
-- Name: meter_code_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX meter_code_tenant_idx ON public.meter_code USING btree (tenant_id);


--
-- Name: session_member_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_member_idx ON public.session USING btree (tenant_id, member_id);


--
-- Name: battery_site battery_site_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER battery_site_updated_at BEFORE UPDATE ON public.battery_site FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: eegfaktura_oidc_token eegfaktura_oidc_token_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER eegfaktura_oidc_token_updated_at BEFORE UPDATE ON public.eegfaktura_oidc_token FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: eegfaktura_source eegfaktura_source_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER eegfaktura_source_updated_at BEFORE UPDATE ON public.eegfaktura_source FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: measurement_point measurement_point_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER measurement_point_updated_at BEFORE UPDATE ON public.measurement_point FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: member member_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER member_updated_at BEFORE UPDATE ON public.member FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: meter_code meter_code_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER meter_code_updated_at BEFORE UPDATE ON public.meter_code FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: tenant tenant_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tenant_updated_at BEFORE UPDATE ON public.tenant FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: battery_site battery_site_measurement_point_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battery_site
    ADD CONSTRAINT battery_site_measurement_point_fkey FOREIGN KEY (tenant_id, measurement_point_id) REFERENCES public.measurement_point(tenant_id, id) ON DELETE SET NULL;


--
-- Name: battery_site battery_site_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battery_site
    ADD CONSTRAINT battery_site_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id);


--
-- Name: battery_site battery_site_tenant_id_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battery_site
    ADD CONSTRAINT battery_site_tenant_id_member_id_fkey FOREIGN KEY (tenant_id, member_id) REFERENCES public.member(tenant_id, id);


--
-- Name: eegfaktura_oidc_token eegfaktura_oidc_token_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eegfaktura_oidc_token
    ADD CONSTRAINT eegfaktura_oidc_token_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id) ON DELETE CASCADE;


--
-- Name: eegfaktura_oidc_token eegfaktura_oidc_token_tenant_id_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eegfaktura_oidc_token
    ADD CONSTRAINT eegfaktura_oidc_token_tenant_id_member_id_fkey FOREIGN KEY (tenant_id, member_id) REFERENCES public.member(tenant_id, id) ON DELETE CASCADE;


--
-- Name: eegfaktura_source eegfaktura_source_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eegfaktura_source
    ADD CONSTRAINT eegfaktura_source_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id);


--
-- Name: eegfaktura_sync_job eegfaktura_sync_job_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eegfaktura_sync_job
    ADD CONSTRAINT eegfaktura_sync_job_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id) ON DELETE CASCADE;


--
-- Name: eegfaktura_sync_job eegfaktura_sync_job_tenant_id_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eegfaktura_sync_job
    ADD CONSTRAINT eegfaktura_sync_job_tenant_id_requested_by_fkey FOREIGN KEY (tenant_id, requested_by) REFERENCES public.member(tenant_id, id) ON DELETE SET NULL;


--
-- Name: forecast_run forecast_run_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forecast_run
    ADD CONSTRAINT forecast_run_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id) ON DELETE CASCADE;


--
-- Name: forecast_value forecast_value_tenant_id_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forecast_value
    ADD CONSTRAINT forecast_value_tenant_id_run_id_fkey FOREIGN KEY (tenant_id, run_id) REFERENCES public.forecast_run(tenant_id, id) ON DELETE CASCADE;


--
-- Name: login_token login_token_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_token
    ADD CONSTRAINT login_token_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id);


--
-- Name: login_token login_token_tenant_id_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_token
    ADD CONSTRAINT login_token_tenant_id_member_id_fkey FOREIGN KEY (tenant_id, member_id) REFERENCES public.member(tenant_id, id) ON DELETE CASCADE;


--
-- Name: measurement_daily measurement_daily_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.measurement_daily
    ADD CONSTRAINT measurement_daily_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id);


--
-- Name: measurement_daily measurement_daily_tenant_id_measurement_point_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.measurement_daily
    ADD CONSTRAINT measurement_daily_tenant_id_measurement_point_id_fkey FOREIGN KEY (tenant_id, measurement_point_id) REFERENCES public.measurement_point(tenant_id, id) ON DELETE CASCADE;


--
-- Name: measurement_daily measurement_daily_tenant_id_meter_code_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.measurement_daily
    ADD CONSTRAINT measurement_daily_tenant_id_meter_code_id_fkey FOREIGN KEY (tenant_id, meter_code_id) REFERENCES public.meter_code(tenant_id, id);


--
-- Name: measurement_point measurement_point_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.measurement_point
    ADD CONSTRAINT measurement_point_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id);


--
-- Name: measurement_point measurement_point_tenant_id_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.measurement_point
    ADD CONSTRAINT measurement_point_tenant_id_member_id_fkey FOREIGN KEY (tenant_id, member_id) REFERENCES public.member(tenant_id, id);


--
-- Name: measurement measurement_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.measurement
    ADD CONSTRAINT measurement_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id);


--
-- Name: measurement measurement_tenant_id_measurement_point_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.measurement
    ADD CONSTRAINT measurement_tenant_id_measurement_point_id_fkey FOREIGN KEY (tenant_id, measurement_point_id) REFERENCES public.measurement_point(tenant_id, id) ON DELETE CASCADE;


--
-- Name: measurement measurement_tenant_id_meter_code_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.measurement
    ADD CONSTRAINT measurement_tenant_id_meter_code_id_fkey FOREIGN KEY (tenant_id, meter_code_id) REFERENCES public.meter_code(tenant_id, id);


--
-- Name: member member_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member
    ADD CONSTRAINT member_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id);


--
-- Name: meter_code meter_code_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meter_code
    ADD CONSTRAINT meter_code_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id);


--
-- Name: session session_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id);


--
-- Name: session session_tenant_id_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_tenant_id_member_id_fkey FOREIGN KEY (tenant_id, member_id) REFERENCES public.member(tenant_id, id) ON DELETE CASCADE;


--
-- Name: weather weather_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weather
    ADD CONSTRAINT weather_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id);


--
-- PostgreSQL database dump complete
--

\unrestrict dbmate


--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('20260807120000'),
    ('20260807120100'),
    ('20260807130000'),
    ('20260807140000'),
    ('20260808120000'),
    ('20260808150000'),
    ('20260808170000'),
    ('20260808180000'),
    ('20260809100000'),
    ('20260824190000'),
    ('20260826200000'),
    ('20260826200100'),
    ('20260826210000'),
    ('20260826220000'),
    ('20260827100000');
