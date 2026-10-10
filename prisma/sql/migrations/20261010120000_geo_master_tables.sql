-- Location master list tables (countries / states / cities) for the signup
-- pickers. Data is loaded by the following *_geo_master_data.sql migration.

CREATE TABLE IF NOT EXISTS `geo_country` (
  `iso2`  CHAR(2)      NOT NULL,
  `name`  VARCHAR(100) NOT NULL,
  PRIMARY KEY (`iso2`)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `geo_state` (
  `id`           INT UNSIGNED NOT NULL,
  `country_iso2` CHAR(2)      NOT NULL,
  `code`         VARCHAR(20)  NOT NULL,  -- GeoNames admin1 code, e.g. IN.16 -> "16"
  `name`         VARCHAR(100) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_geo_state_country_code` (`country_iso2` ASC, `code` ASC) VISIBLE,
  INDEX `idx_geo_state_country_name` (`country_iso2` ASC, `name` ASC) VISIBLE,
  CONSTRAINT `fk_geo_state_country`
    FOREIGN KEY (`country_iso2`) REFERENCES `geo_country` (`iso2`)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `geo_city` (
  `id`           INT UNSIGNED NOT NULL,
  `country_iso2` CHAR(2)      NOT NULL,
  `state_id`     INT UNSIGNED NULL DEFAULT NULL,  -- NULL when GeoNames has no admin1 for it
  `name`         VARCHAR(100) NOT NULL,
  `population`   INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  INDEX `idx_geo_city_state_name` (`state_id` ASC, `name` ASC) VISIBLE,
  INDEX `idx_geo_city_country_name` (`country_iso2` ASC, `name` ASC) VISIBLE,
  CONSTRAINT `fk_geo_city_country`
    FOREIGN KEY (`country_iso2`) REFERENCES `geo_country` (`iso2`),
  CONSTRAINT `fk_geo_city_state`
    FOREIGN KEY (`state_id`) REFERENCES `geo_state` (`id`)
) ENGINE = InnoDB;
