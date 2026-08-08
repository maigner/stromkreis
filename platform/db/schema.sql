--
-- PostgreSQL database dump
--

\restrict YW1zeaaIZWh93KXMACdOPoM6la6iTaRBPEK4lE4F9I2yV6MbmCehWanBEuJ7Pdk

-- Dumped from database version 17.10
-- Dumped by pg_dump version 17.10

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
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    new.updated_at := now();
    return new;
end;
$$;


ALTER FUNCTION public.set_updated_at() OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: login_token; Type: TABLE; Schema: public; Owner: postgres
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


ALTER TABLE public.login_token OWNER TO postgres;

--
-- Name: login_token_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
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
-- Name: measurement; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.measurement (
    tenant_id bigint NOT NULL,
    measurement_point_id bigint NOT NULL,
    meter_code_id bigint NOT NULL,
    measured_at timestamp with time zone NOT NULL,
    value numeric(19,10) NOT NULL
);


ALTER TABLE public.measurement OWNER TO postgres;

--
-- Name: measurement_point; Type: TABLE; Schema: public; Owner: postgres
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


ALTER TABLE public.measurement_point OWNER TO postgres;

--
-- Name: measurement_point_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
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
-- Name: member; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.member (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    name text NOT NULL,
    email text,
    role text DEFAULT 'member'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT member_operator_has_email CHECK (((role <> 'operator'::text) OR (email IS NOT NULL))),
    CONSTRAINT member_role_check CHECK ((role = ANY (ARRAY['member'::text, 'board'::text, 'operator'::text])))
);


ALTER TABLE public.member OWNER TO postgres;

--
-- Name: member_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
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
-- Name: meter_code; Type: TABLE; Schema: public; Owner: postgres
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


ALTER TABLE public.meter_code OWNER TO postgres;

--
-- Name: meter_code_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
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
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


ALTER TABLE public.schema_migrations OWNER TO postgres;

--
-- Name: session; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.session (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    member_id bigint NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.session OWNER TO postgres;

--
-- Name: session_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
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
-- Name: tenant; Type: TABLE; Schema: public; Owner: postgres
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


ALTER TABLE public.tenant OWNER TO postgres;

--
-- Name: tenant_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
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
-- Name: weather; Type: TABLE; Schema: public; Owner: postgres
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


ALTER TABLE public.weather OWNER TO postgres;

--
-- Name: login_token login_token_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.login_token
    ADD CONSTRAINT login_token_pkey PRIMARY KEY (id);


--
-- Name: login_token login_token_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.login_token
    ADD CONSTRAINT login_token_token_hash_key UNIQUE (token_hash);


--
-- Name: measurement measurement_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.measurement
    ADD CONSTRAINT measurement_pkey PRIMARY KEY (tenant_id, measurement_point_id, meter_code_id, measured_at);


--
-- Name: measurement_point measurement_point_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.measurement_point
    ADD CONSTRAINT measurement_point_pkey PRIMARY KEY (id);


--
-- Name: measurement_point measurement_point_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.measurement_point
    ADD CONSTRAINT measurement_point_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: measurement_point measurement_point_tenant_id_metering_point_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.measurement_point
    ADD CONSTRAINT measurement_point_tenant_id_metering_point_key UNIQUE (tenant_id, metering_point);


--
-- Name: member member_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.member
    ADD CONSTRAINT member_pkey PRIMARY KEY (id);


--
-- Name: member member_tenant_id_email_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.member
    ADD CONSTRAINT member_tenant_id_email_key UNIQUE (tenant_id, email);


--
-- Name: member member_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.member
    ADD CONSTRAINT member_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: meter_code meter_code_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.meter_code
    ADD CONSTRAINT meter_code_pkey PRIMARY KEY (id);


--
-- Name: meter_code meter_code_tenant_id_description_unit_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.meter_code
    ADD CONSTRAINT meter_code_tenant_id_description_unit_key UNIQUE (tenant_id, description, unit);


--
-- Name: meter_code meter_code_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.meter_code
    ADD CONSTRAINT meter_code_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: session session_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_token_hash_key UNIQUE (token_hash);


--
-- Name: tenant tenant_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tenant
    ADD CONSTRAINT tenant_pkey PRIMARY KEY (id);


--
-- Name: tenant tenant_slug_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tenant
    ADD CONSTRAINT tenant_slug_key UNIQUE (slug);


--
-- Name: weather weather_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.weather
    ADD CONSTRAINT weather_pkey PRIMARY KEY (tenant_id, "time");


--
-- Name: login_token_member_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX login_token_member_idx ON public.login_token USING btree (tenant_id, member_id);


--
-- Name: measurement_point_member_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX measurement_point_member_idx ON public.measurement_point USING btree (tenant_id, member_id);


--
-- Name: measurement_point_tenant_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX measurement_point_tenant_idx ON public.measurement_point USING btree (tenant_id);


--
-- Name: measurement_tenant_time_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX measurement_tenant_time_idx ON public.measurement USING btree (tenant_id, measured_at);


--
-- Name: member_tenant_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX member_tenant_idx ON public.member USING btree (tenant_id);


--
-- Name: meter_code_tenant_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX meter_code_tenant_idx ON public.meter_code USING btree (tenant_id);


--
-- Name: session_member_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX session_member_idx ON public.session USING btree (tenant_id, member_id);


--
-- Name: measurement_point measurement_point_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER measurement_point_updated_at BEFORE UPDATE ON public.measurement_point FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: member member_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER member_updated_at BEFORE UPDATE ON public.member FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: meter_code meter_code_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER meter_code_updated_at BEFORE UPDATE ON public.meter_code FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: tenant tenant_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER tenant_updated_at BEFORE UPDATE ON public.tenant FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: login_token login_token_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.login_token
    ADD CONSTRAINT login_token_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id);


--
-- Name: login_token login_token_tenant_id_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.login_token
    ADD CONSTRAINT login_token_tenant_id_member_id_fkey FOREIGN KEY (tenant_id, member_id) REFERENCES public.member(tenant_id, id) ON DELETE CASCADE;


--
-- Name: measurement_point measurement_point_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.measurement_point
    ADD CONSTRAINT measurement_point_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id);


--
-- Name: measurement_point measurement_point_tenant_id_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.measurement_point
    ADD CONSTRAINT measurement_point_tenant_id_member_id_fkey FOREIGN KEY (tenant_id, member_id) REFERENCES public.member(tenant_id, id);


--
-- Name: measurement measurement_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.measurement
    ADD CONSTRAINT measurement_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id);


--
-- Name: measurement measurement_tenant_id_measurement_point_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.measurement
    ADD CONSTRAINT measurement_tenant_id_measurement_point_id_fkey FOREIGN KEY (tenant_id, measurement_point_id) REFERENCES public.measurement_point(tenant_id, id) ON DELETE CASCADE;


--
-- Name: measurement measurement_tenant_id_meter_code_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.measurement
    ADD CONSTRAINT measurement_tenant_id_meter_code_id_fkey FOREIGN KEY (tenant_id, meter_code_id) REFERENCES public.meter_code(tenant_id, id);


--
-- Name: member member_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.member
    ADD CONSTRAINT member_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id);


--
-- Name: meter_code meter_code_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.meter_code
    ADD CONSTRAINT meter_code_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id);


--
-- Name: session session_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id);


--
-- Name: session session_tenant_id_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_tenant_id_member_id_fkey FOREIGN KEY (tenant_id, member_id) REFERENCES public.member(tenant_id, id) ON DELETE CASCADE;


--
-- Name: weather weather_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.weather
    ADD CONSTRAINT weather_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id);


--
-- PostgreSQL database dump complete
--

\unrestrict YW1zeaaIZWh93KXMACdOPoM6la6iTaRBPEK4lE4F9I2yV6MbmCehWanBEuJ7Pdk

INSERT INTO public.schema_migrations VALUES ('20260807120000');
INSERT INTO public.schema_migrations VALUES ('20260807120100');
INSERT INTO public.schema_migrations VALUES ('20260807130000');
INSERT INTO public.schema_migrations VALUES ('20260807140000');
INSERT INTO public.schema_migrations VALUES ('20260808120000');
