-- Database-per-service: each service owns its schema and runs its own migrations.
-- (One Postgres instance in the POC; separate clusters in production.)
CREATE DATABASE users_db;
CREATE DATABASE posts_db;
CREATE DATABASE feed_db;
