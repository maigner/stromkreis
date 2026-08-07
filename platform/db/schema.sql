--
-- PostgreSQL database dump
--

\restrict xjY1rNomOMjQVwhDgbVoM33QSz9Mm8ftR3ZwczFzTmy4wYyL68YGGV2foxYByfu

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
    CONSTRAINT member_operator_has_email CHECK (((role <> 'operator'::text) OR (email IS NOT NULL))),
    CONSTRAINT member_role_check CHECK ((role = ANY (ARRAY['member'::text, 'board'::text, 'operator'::text])))
);


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
-- Name: login_token_member_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX login_token_member_idx ON public.login_token USING btree (tenant_id, member_id);


--
-- Name: measurement_point_member_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX measurement_point_member_idx ON public.measurement_point USING btree (tenant_id, member_id);


--
-- Name: measurement_point_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX measurement_point_tenant_idx ON public.measurement_point USING btree (tenant_id);


--
-- Name: member_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX member_tenant_idx ON public.member USING btree (tenant_id);


--
-- Name: session_member_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_member_idx ON public.session USING btree (tenant_id, member_id);


--
-- Name: measurement_point measurement_point_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER measurement_point_updated_at BEFORE UPDATE ON public.measurement_point FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: member member_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER member_updated_at BEFORE UPDATE ON public.member FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: tenant tenant_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tenant_updated_at BEFORE UPDATE ON public.tenant FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


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
-- Name: member member_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member
    ADD CONSTRAINT member_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id);


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
-- PostgreSQL database dump complete
--

\unrestrict xjY1rNomOMjQVwhDgbVoM33QSz9Mm8ftR3ZwczFzTmy4wYyL68YGGV2foxYByfu

INSERT INTO public.schema_migrations VALUES ('20260807120000');
INSERT INTO public.schema_migrations VALUES ('20260807120100');
INSERT INTO public.schema_migrations VALUES ('20260807130000');
INSERT INTO public.schema_migrations VALUES ('20260807140000');
