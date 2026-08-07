-- migrate:up

-- Neue Rolle "operator" (Betreiber): verwaltet den Mandanten (Verzeichnis,
-- CSV-Import, Speicherkonfiguration). Jeder Mandant hat mindestens einen
-- Betreiber-Login; das wird beim Mandanten-Onboarding sichergestellt,
-- nicht per Constraint.
alter table member drop constraint member_role_check;
alter table member add constraint member_role_check
    check (role in ('member', 'board', 'operator'));

-- Login ist Magic-Link per E-Mail: Betreiber ohne E-Mail waere nicht anmeldbar
alter table member add constraint member_operator_has_email
    check (role <> 'operator' or email is not null);

-- migrate:down

-- Achtung: entfernt Betreiber-Zeilen, sonst wuerde der alte Check scheitern
delete from member where role = 'operator';
alter table member drop constraint member_operator_has_email;
alter table member drop constraint member_role_check;
alter table member add constraint member_role_check
    check (role in ('member', 'board'));
