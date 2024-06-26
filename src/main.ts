import { LitElement, html } from "lit";
import { property, state } from "lit/decorators.js";
import { hasTemplate } from "card-tools/src/templates";
import { bind_template, unbind_template } from "./templates";
import { filter_entity } from "./filter";
import { get_sorter } from "./sort";
import {
  EntityNameConfig,
  AutoEntitiesConfig,
  EntityList,
  HuiErrorCard,
  LovelaceCard,
  LovelaceRowConfig,
} from "./types";
import pjson from "../package.json";
import "./editor/auto-entities-editor";
import { compare_deep, getAreas, getDevices, getEntities } from "./helpers";

window.queueMicrotask =
  window.queueMicrotask || ((handler) => window.setTimeout(handler, 1));

const HIDDEN_TYPES = ["section", "divider"];

class AutoEntities extends LitElement {
  @property() _config: AutoEntitiesConfig;
  @property() hass: any;
  @property() card: LovelaceCard;
  @property() else?: LovelaceCard;
  @property() _template: string[];
  @state() empty = false;

  _entities: EntityList;
  _cardConfig;
  _updateCooldown = { timer: undefined, rerun: false };
  _cardBuilt?: Promise<void>;
  _cardBuiltResolve?;

  static getConfigElement() {
    return document.createElement("auto-entities-editor");
  }
  static getStubConfig() {
    return {
      card: {
        type: "entities",
      },
      filter: {
        include: [],
        exclude: [],
      },
    };
  }

  setConfig(config: AutoEntitiesConfig) {
    if (!config) {
      throw new Error("No configuration.");
    }
    if (!config.card?.type) {
      throw new Error("No card type specified.");
    }
    if (!config.filter && !config.entities) {
      throw new Error("No filters specified.");
    }
    if (config.names && !config.names.transforms) {
      throw new Error("No names transforms specified.");
    }
    config = JSON.parse(JSON.stringify(config));
    this._config = config;

    if (
      this._config.filter?.template &&
      hasTemplate(this._config.filter.template)
    ) {
      bind_template(this._renderer, this._config.filter.template, { config });
    }

    this._cardBuilt = new Promise(
      (resolve) => (this._cardBuiltResolve = resolve)
    );

    queueMicrotask(() => this.build_else());
    queueMicrotask(() => this.update_all());
  }

  _renderer = (tpl) => {
    if (typeof tpl === "string") {
      this._template = tpl.split(/[\s,]+/);
    } else {
      this._template = tpl;
    }
  };

  connectedCallback() {
    super.connectedCallback();
    if (
      this._config?.filter?.template &&
      hasTemplate(this._config.filter.template)
    ) {
      bind_template(this._renderer, this._config.filter.template, {
        config: this._config,
      });
    }
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    unbind_template(this._renderer);
  }

  async update_all() {
    if (this.card) this.card.hass = this.hass;
    if (this.else) this.else.hass = this.hass;

    if (this._updateCooldown.timer) {
      this._updateCooldown.rerun = true;
      return;
    } else {
      this._updateCooldown.rerun = false;
      this._updateCooldown.timer = window.setTimeout(() => {
        this._updateCooldown.timer = undefined;
        if (this._updateCooldown.rerun) this.update_all();
      }, 500);
    }

    const entities = await this.update_entities();
    this.update_card(entities);
  }

  async build_else() {
    if (this._config.else === undefined) return;
    const helpers = await (window as any).loadCardHelpers();
    this.else = await helpers.createCardElement(this._config.else);
    this.else.hass = this.hass;
  }

  async update_card(entities: EntityList) {
    if (
      this._entities &&
      compare_deep(entities, this._entities) &&
      compare_deep(this._cardConfig, this._config.card)
    )
      return;
    const newType = this._cardConfig?.type !== this._config.card.type;
    this._entities = entities;
    this._cardConfig = JSON.parse(JSON.stringify(this._config.card));
    const cardConfig = {
      [this._config.card_param || "entities"]: entities,
      ...this._config.card,
    };
    if (!this.card || newType) {
      const helpers = await (window as any).loadCardHelpers();

      // Replace console.error in order to catch errors from cards which don't like to be given an empty entities list
      (console as any).oldError = (console as any).oldError || [];
      const _consoleError = console.error;
      (console as any).oldError.push(_consoleError);
      console.error = (...args) => {
        if (args.length === 3 && args[2].message) {
          if (
            args[2].message.startsWith?.("Entities") || // Logbook-card
            args[2].message.startsWith?.("Either entities") || // Map card
            args[2].message.endsWith?.("entity") // History-graph card
          ) {
            return;
          }
        }
        _consoleError(...args);
      };

      try {
        this.card = await helpers.createCardElement(cardConfig);

        if (this.card.localName === "hui-error-card") {
          const errorCard = this.card as HuiErrorCard;
          await customElements.whenDefined("hui-error-card");
          let ctr = 10;
          while (!errorCard._config && ctr) {
            await new Promise((resolve) => window.setTimeout(resolve, 100));
            ctr--;
          }
          if (
            errorCard._config?.error?.startsWith?.("Entities") ||
            errorCard._config?.error?.startsWith?.("Either entities") ||
            errorCard._config?.error?.endsWith?.("entity")
          ) {
            this.card = undefined;
            this._entities = undefined;
            this._cardConfig = undefined;
            this._cardBuiltResolve?.();
            return;
          }
        }
      } finally {
        console.error = (console as any).oldError.pop();
      }
    } else {
      this.card.setConfig(cardConfig);
    }

    this._cardBuiltResolve?.();
    this.card.hass = this.hass;

    this.empty =
      entities.length === 0 ||
      entities.every((e) => HIDDEN_TYPES.includes(e.type));
    const hide =
      this.empty &&
      this._config.show_empty === false &&
      this._config.else === undefined;
    this.style.display = hide ? "none" : null;
    this.style.margin = hide ? "0" : null;
    if ((this.card as any).requestUpdate) {
      await this.updateComplete;
      (this.card as any).requestUpdate();
    }
  }

  async update_entities() {
    const format = (entity: LovelaceRowConfig | string): LovelaceRowConfig => {
      if (!entity) return null;
      return typeof entity === "string" ? { entity: entity.trim() } : entity;
    };

    let entities: EntityList = [...(this._config?.entities?.map(format) || [])];

    if (!this.hass) {
      return entities;
    }

    if (this._template) {
      entities = entities.concat(this._template.map(format));
    }
    entities = entities.filter(Boolean);

    if (this._config.filter?.include) {
      const all_entities = Object.keys(this.hass.states).map(format);
      for (const filter of this._config.filter.include) {
        if (filter.type) {
          entities.push(filter);
          continue;
        }

        let add: EntityList = [];
        for (const entity of all_entities) {
          if (await filter_entity(this.hass, filter, entity.entity))
            add.push(
              JSON.parse(
                JSON.stringify({ ...entity, ...filter.options }).replace(
                  /this.entity_id/g,
                  entity.entity
                )
              )
            );
        }

        if (filter.sort) {
          await getEntities(this.hass);
          await getDevices(this.hass);
          await getAreas(this.hass);
          add = add.sort(get_sorter(this.hass, filter.sort));
          if (filter.sort.count ?? filter.sort.first) {
            const start = filter.sort.first ?? 0;
            add = add.slice(start, start + (filter.sort.count ?? Infinity));
          }
        }
        entities = entities.concat(add);
      }
    }

    // TODO: Add tests for exclusions
    if (this._config.filter?.exclude) {
      for (const filter of this._config.filter.exclude) {
        const newEntities = [];
        for (const entity of entities) {
          if (
            entity.entity === undefined ||
            !(await filter_entity(this.hass, filter, entity.entity))
          )
            newEntities.push(entity);
        }
        entities = newEntities;
      }
    }

    if (this._config.names) {
      const { transforms } = this._config.names;
      if (transforms && transforms.length > 0) {
        const ents = await getEntities(this.hass);
        const devs = await getDevices(this.hass);
        const areas = await getAreas(this.hass);

        const findEnt = entity => ents.find((e) => e.entity_id === entity.entity);
        const findDev = ent => devs.find((e) => e.id === ent.device_id);
        const findArea = ent => areas.find((a) => a.area_id === ent.area_id);

        const getEntName = (entity: LovelaceRowConfig, ent: any) => {
          let name = "";
          if (entity.name) {
            name = entity.name;
          } else if (ent.friendly_name) {
            name = ent.friendly_name;
          } else if (ent.name) {
            name = ent.name;
          } else if (ent.device_id) {
            const device = findDev(ent);
            if (device && device.name) {
              if (ent.original_name) {
                if (ent.original_name !== device.name) {
                  if (ent.original_name.startsWith(device.name)) {
                    name = ent.original_name;
                  } else {
                    name = device.name + " " + ent.original_name;
                  }
                } else {
                  name = device.name;
                }
              } else {
                name = device.name;
              }
            } else if (ent.original_name) {
              name = ent.original_name;
            }
          } else if (ent.original_name) {
            name = ent.original_name;
          }
          return name;
        };

        const getEntAreaName = ent => {
          let area;
          if (ent.area_id) {
            area = findArea(ent);
          }
          if (!area && ent.device_id !== undefined) {
            const device = findDev(ent);
            if (device) {
              area = findArea(device);
            }
          }
          if (area && area.name) {
            return area.name;
          }
          return "";
        };

        const getEntGroupName = group => {
          const groupEnt = this.hass.states[group];
          if (groupEnt && groupEnt.attributes.friendly_name) {
            return groupEnt.attributes.friendly_name;
          }
          return "";
        };

        const getEntDeviceName = ent => {
          if (ent.device_id) {
            const device = findDev(ent);
            if (device && device.name) {
              return device.name;
            }
          }
          return "";
        };

        const getEntDeviceManufacturerName = ent => {
          if (ent.device_id !== undefined) {
            const device = findDev(ent);
            if (device && device.manufacturer) {
              return device.manufacturer;
            }
          }
          return "";
        };

        const getEntDeviceModelName = ent => {
          if (ent.device_id !== undefined) {
            const device = findDev(ent);
            if (device && device.model) {
              return device.model;
            }
          }
          return "";
        };

        const getEntNameForConfig = (ent: any, config: EntityNameConfig) => {
          const { text, area, group, device, device_manufacturer, device_model } = config;
          if (text) {
            return text;
          } else if (area) {
            return getEntAreaName(ent);
          } else if (group) {
            return getEntGroupName(group);
          } else if (device) {
            return getEntDeviceName(ent);
          } else if (device_manufacturer) {
            return getEntDeviceManufacturerName(ent);
          } else if (device_model) {
            return getEntDeviceModelName(ent);
          }
        };

        const newEntities = entities.map(e => ({...e}));

        for (let transform of transforms) {
          const { type, trim } = transform;
          if (type === "set" || type === "prefix" || type === "suffix") {
            const { value } = transform;
            if (value) {
              let getEntityName = (oldName, newName) => oldName;
              if (type === "set") {
                getEntityName = (oldName, newName) => newName;
              } else if (type === "prefix") {
                getEntityName = (oldName, newName) => newName + oldName;
              } else if (type === "suffix") {
                getEntityName = (oldName, newName) => oldName + newName;
              }
              for (let entity of newEntities) {
                const ent = findEnt(entity);
                if (ent) {
                  const oldName = getEntName(entity, ent);
                  const newName = getEntNameForConfig(ent, value);
                  if (oldName && newName) {
                    entity.name = getEntityName(oldName, newName);
                    if (trim) {
                      entity.name = entity.name.trim();
                    }
                  }
                }
              }
            }
          } else if (type === "replace") {
            const { match, replacement } = transform;
            if (match) {
              for (let entity of newEntities) {
                const ent = findEnt(entity);
                if (ent) {
                  const oldName = getEntName(entity, ent);
                  const matchName = getEntNameForConfig(ent, match);
                  if (oldName && matchName) {
                    const replaceName = replacement ? getEntNameForConfig(ent, replacement) : "";
                    entity.name = oldName.replace(matchName, replaceName);
                    if (trim) {
                      entity.name = entity.name.trim();
                    }
                  }
                }
              }
            }
          }
        }
        entities = newEntities;
      }
    }

    if (this._config.sort) {
      entities = entities.sort(get_sorter(this.hass, this._config.sort));
      if (this._config.sort.count) {
        const start = this._config.sort.first ?? 0;
        entities = entities.slice(start, start + this._config.sort.count);
      }
    }

    if (this._config.unique) {
      let newEntities: EntityList = [];
      for (const e of entities) {
        if (
          this._config.unique === "entity" &&
          e.entity &&
          newEntities.some((i) => i.entity === e.entity)
        )
          continue;
        if (newEntities.some((i) => compare_deep(i, e))) continue;
        newEntities.push(e);
      }
      entities = newEntities;
    }

    return entities;
  }

  async updated(changedProperties) {
    if (
      changedProperties.has("_template") ||
      (changedProperties.has("hass") && this.hass)
    ) {
      queueMicrotask(() => this.update_all());
    }
  }

  createRenderRoot() {
    return this;
  }
  render() {
    return html`${this.empty &&
    (this._config.show_empty === false || this._config.else)
      ? this.else
      : this.card}`;
  }

  async getCardSize() {
    let len = 0;
    await this._cardBuilt;
    if (this.card && this.card.getCardSize) len = await this.card.getCardSize();
    if (len === 1 && this._entities?.length) len = this._entities.length;
    if (len === 0 && this._config.filter?.include)
      len = Object.keys(this._config.filter.include).length;
    return len || 5;
  }
}

if (!customElements.get("auto-named-entities")) {
  customElements.define("auto-named-entities", AutoEntities);
  console.groupCollapsed(
    `%cAUTO-NAMED-ENTITIES ${pjson.version} IS INSTALLED`,
    "color: green; font-weight: bold"
  );
  console.log(
    "Readme:",
    "https://github.com/jharris4/lovelace-auto-named-entities"
  );
  console.groupEnd();
}
