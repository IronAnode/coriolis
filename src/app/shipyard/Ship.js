import * as Calc from './Calculations';
import * as ModuleUtils from './ModuleUtils';
import Module from './Module';
import LZString from 'lz-string';
import isEqual from 'lodash/lang';
import { Modifications } from 'coriolis-data/dist';
const zlib = require('zlib');

const UNIQUE_MODULES = ['psg', 'sg', 'bsg', 'rf', 'fs', 'fh'];

/**
 * Returns the power usage type of a slot and it's particular module
 * @param  {Object} slot      The Slot
 * @param  {Object} modul     The module in the slot
 * @return {String}           The key for the power usage type
 */
function powerUsageType(slot, modul) {
  if (modul) {
    if (modul.passive) {
      return 'retracted';
    }
  }
  return slot.cat != 1 ? 'retracted' : 'deployed';
}

/**
 * Populates the category array with module IDs from
 * the provided code
 * @param  {String} code    Serialized ship code
 * @param  {Array}  arr     Category array
 * @param  {Number} codePos Current position/Index of code string
 * @return {Number}         Next position/Index of code string
 */
function decodeToArray(code, arr, codePos) {
  for (let i = 0; i < arr.length; i++) {
    if (code.charAt(codePos) == '-') {
      arr[i] = 0;
      codePos++;
    } else {
      arr[i] = code.substring(codePos, codePos + 2);
      codePos += 2;
    }
  }
  return codePos;
}

/**
 * Reduce function used to get the IDs for a slot group (or array of slots)
 * @param  {array} idArray    The current Array of IDs
 * @param  {Object} slot      Slot object
 * @param  {integer} slotIndex The index for the slot in its group
 * @return {array}           The mutated idArray
 */
function reduceToIDs(idArray, slot, slotIndex) {
  idArray[slotIndex] = slot.m ? slot.m.id : '-';
  return idArray;
}

/**
 * Ship Model - Encapsulates and models in-game ship behavior
 */
export default class Ship {

  /**
   * @param {String} id         Unique ship Id / Key
   * @param {Object} properties Basic ship properties such as name, manufacturer, mass, etc
   * @param {Object} slots      Collection of slot groups (standard/standard, internal, hardpoints) with their max class size.
   */
  constructor(id, properties, slots) {
    this.id = id;
    this.serialized = {};
    this.cargoHatch = { m: ModuleUtils.cargoHatch(), type: 'SYS' };
    this.bulkheads = { incCost: true, maxClass: 8 };
    this.availCS = ModuleUtils.forShip(id);

    for (let p in properties) { this[p] = properties[p]; }  // Copy all base properties from shipData

    for (let slotType in slots) {   // Initialize all slots
      let slotGroup = slots[slotType];
      let group = this[slotType] = [];   // Initialize Slot group (Standard, Hardpoints, Internal)
      for (let slot of slotGroup) {
        if (typeof slot == 'object') {
          group.push({ m: null, incCost: true, maxClass: slot.class, eligible: slot.eligible });
        } else {
          group.push({ m: null, incCost: true, maxClass: slot });
        }
      }
    }
    // Make a Ship 'slot'/item similar to other slots
    this.m = { incCost: true, type: 'SHIP', discountedCost: this.hullCost, m: { class: '', rating: '', name: this.name, cost: this.hullCost } };
    this.costList = this.internal.concat(this.m, this.standard, this.hardpoints, this.bulkheads);
    this.powerList = this.internal.concat(
      this.cargoHatch,
      this.standard[0],  // Add Power Plant
      this.standard[2],  // Add FSD
      this.standard[1],  // Add Thrusters
      this.standard[4],  // Add Power Distributor
      this.standard[5],  // Add Sensors
      this.standard[3],  // Add Life Support
      this.hardpoints
    );
    this.moduleCostMultiplier = 1;
    this.priorityBands = [
      { deployed: 0, retracted: 0, },
      { deployed: 0, retracted: 0, },
      { deployed: 0, retracted: 0, },
      { deployed: 0, retracted: 0, },
      { deployed: 0, retracted: 0, }
    ];
  }

  /* GETTERS */

  /**
   * Can the ship thrust/move
   * @return {[type]} True if thrusters operational
   */
  canThrust() {
    return this.getSlotStatus(this.standard[1]) == 3 &&   // Thrusters are powered
        this.ladenMass < this.standard[1].m.getMaxMass(); // Max mass not exceeded
  }

  /**
   * Can the ship boost
   * @return {[type]} True if boost capable
   */
  canBoost() {
    return this.canThrust() &&                                       // Thrusters operational
        this.getSlotStatus(this.standard[4]) == 3 &&                 // Power distributor operational
        this.boostEnergy <= this.standard[4].m.getEnginesCapacity(); // PD capacitor is sufficient for boost
  }

    /**
   * Calculate hypothetical jump range using the installed FSD and the
   * specified mass which can be more or less than ships actual mass
   * @param  {Number} fuel  Fuel available in tons
   * @param  {Number} cargo Cargo in tons
   * @return {Number}       Jump range in Light Years
   */
  calcJumpRangeWith(fuel, cargo) {
    return Calc.jumpRange(this.unladenMass + fuel + cargo, this.standard[2].m, fuel);
  }

  /**
   * Calculate the hypothetical laden jump range based on a potential change in mass, fuel, or FSD
   * @param  {Number} massDelta Optional - Change in laden mass (mass + cargo + fuel)
   * @param  {Number} fuel      Optional - Available fuel (defaults to max fuel based on FSD)
   * @param  {Object} fsd       Optional - Frame Shift Drive (or use mounted FSD)
   * @return {Number}           Jump range in Light Years
   */
  calcLadenRange(massDelta, fuel, fsd) {
    return Calc.jumpRange(this.ladenMass + (massDelta || 0), fsd || this.standard[2].m, fuel);
  }

  /**
   * Calculate the hypothetical unladen jump range based on a potential change in mass, fuel, or FSD
   * @param  {Number} massDelta Optional - Change in ship mass
   * @param  {Number} fuel      Optional - Available fuel (defaults to lesser of fuel capacity or max fuel based on FSD)
   * @param  {Object} fsd       Optional - Frame Shift Drive (or use mounted FSD)
   * @return {Number}           Jump range in Light Years
   */
  calcUnladenRange(massDelta, fuel, fsd) {
    fsd = fsd || this.standard[2].m;
    let fsdMaxFuelPerJump = fsd instanceof Module ? fsd.getMaxFuelPerJump() : fsd.maxfuel;
    return Calc.jumpRange(this.unladenMass + (massDelta || 0) +  Math.min(fsdMaxFuelPerJump, fuel || this.fuelCapacity), fsd || this.standard[2].m, fuel);
  }

  /**
   * Calculate cumulative (total) jump range when making longest jumps using the installed FSD and the
   * specified mass which can be more or less than ships actual mass
   * @param  {Number} fuel  Fuel available in tons
   * @param  {Number} cargo Cargo in tons
   * @return {Number}       Total/Cumulative Jump range in Light Years
   */
  calcFastestRangeWith(fuel, cargo) {
    return Calc.fastestRange(this.unladenMass + fuel + cargo, this.standard[2].m, fuel);
  }

  /**
   * Calculate the hypothetical top speeds at cargo and fuel tonnage
   * @param  {Number} fuel  Fuel available in tons
   * @param  {Number} cargo Cargo in tons
   * @return {Object}       Speed at pip settings and boost
   */
  calcSpeedsWith(fuel, cargo) {
    return Calc.speed(this.unladenMass + fuel + cargo, this.speed, this.boost, this.standard[1].m, this.pipSpeed);
  }

  /**
   * Calculate the recovery time after losing or turning on shields
   * Thanks to CMDRs Al Gray, GIF, and Nomad Enigma for providing Shield recharge data and formulas
   *
   * @return {Number} Recovery time in seconds
   */
  calcShieldRecovery() {
    if (this.shield > 0) {
      let sgSlot = this.findInternalByGroup('sg');
      let brokenRegenRate = 1 + sgSlot.m.getModValue('brokenregen');
      // 50% of shield strength / recovery recharge rate + 15 second delay before recharge starts
      return ((this.shield / 2) / (sgSlot.m.recover * brokenRegenRate)) + 15;
    }
    return 0;
  }

  /**
   * Calculate the recharge time for a shield going from 50% to 100%
   * Thanks to CMDRs Al Gray, GIF, and Nomad Enigma for providing Shield recharge data and formulas
   *
   * @return {Number} 50 - 100% Recharge time in seconds
   */
  calcShieldRecharge() {
    if (this.shield > 0) {
      let sgSlot = this.findInternalByGroup('sg');
      let regenRate = 1 + sgSlot.m.getModValue('regen');
      // 50% -> 100% recharge time, Bi-Weave shields charge at 1.8 MJ/s
      return (this.shield / 2) / ((sgSlot.m.grp == 'bsg' ? 1.8 : 1) * regenRate);
    }
    return 0;
  }

  /**
   * Calculate the hypothetical shield strength for the ship using the specified parameters
   * @param  {Object} sg              [optional] Shield Generator to use
   * @param  {Number} multiplierDelta [optional] Change to shield multiplier (+0.2, - 0.12, etc)
   * @return {Number}                 Shield strength in MJ
   */
  calcShieldStrengthWith(sg, multiplierDelta) {
    if (!sg) {
      let sgSlot = this.findInternalByGroup('sg');
      if (!sgSlot) {
        return 0;
      }
      sg = sgSlot.m;
    }

    // TODO obtain shield boost
    // return Calc.shieldStrength(this.hullMass, this.baseShieldStrength, sg, this.shieldMultiplier + (multiplierDelta || 0));
    return Calc.shieldStrength(this.hullMass, this.baseShieldStrength, sg, 0 + (multiplierDelta || 0));
  }

  /**
   * Get the set of available modules for this ship
   * @return {ModuleSet} Available module set
   */
  getAvailableModules() {
    return this.availCS;
  }

  /**
   * Returns the a slots power status:
   *  0 - No status [Blank]
   *  1 - Disabled (Switched off)
   *  2 - Offline (Insufficient power available)
   *  3 - Online
   * @param  {Object} slot        Slot model
   * @param  {boolean} deployed   True - power used when hardpoints are deployed
   * @return {Number}             status index
   */
  getSlotStatus(slot, deployed) {
    if (!slot.m) { // Empty Slot
      return 0;   // No Status (Not possible to be active in this state)
    } else if (!slot.enabled) {
      return 1;   // Disabled
    } else if (deployed) {
      return this.priorityBands[slot.priority].deployedSum >= this.powerAvailable ? 2 : 3; // Offline : Online
      // Active hardpoints have no retracted status
    } else if ((slot.cat === 1 && !slot.m.passive)) {
      return 0;  // No Status (Not possible to be active in this state)
    }
    return this.priorityBands[slot.priority].retractedSum >= this.powerAvailable ? 2 : 3;    // Offline : Online
  }

  /**
   * Find an internal slot that has an installed modul of the specific group.
   *
   * @param  {String} group Module group/type
   * @return {Number}       The index of the slot in ship.internal
   */
  findInternalByGroup(group) {
    if (ModuleUtils.isShieldGenerator(group)) {
      return this.internal.find(slot => slot.m && ModuleUtils.isShieldGenerator(slot.m.grp));
    } else {
      return this.internal.find(slot => slot.m && slot.m.grp == group);
    }
  }

  /**
   * Serializes the ship to a string
   * @return {String} Serialized ship 'code'
   */
  toString() {
    return [
      this.getStandardString(),
      this.getHardpointsString(),
      this.getInternalString(),
      '.',
      this.getPowerEnabledString(),
      '.',
      this.getPowerPrioritiesString(),
      '.',
      this.getModificationsString()
    ].join('');
  }

  /**
   * Serializes the standard modules to a string
   * @return {String} Serialized standard modules 'code'
   */
  getStandardString() {
    if(!this.serialized.standard) {
      this.serialized.standard = this.bulkheads.m.index + this.standard.reduce((arr, slot, i) => {
        arr[i] = slot.m ? slot.m.id : '-';
        return arr;
      }, new Array(this.standard.length)).join('');
    }
    return this.serialized.standard;
  }

  /**
   * Serializes the internal modules to a string
   * @return {String} Serialized internal modules 'code'
   */
  getInternalString() {
    if(!this.serialized.internal) {
      this.serialized.internal = this.internal.reduce(reduceToIDs, new Array(this.internal.length)).join('');
    }
    return this.serialized.internal;
  }

  /**
   * Serializes the hardpoints and utility modules to a string
   * @return {String} Serialized hardpoints and utility modules 'code'
   */
  getHardpointsString() {
    if(!this.serialized.hardpoints) {
      this.serialized.hardpoints = this.hardpoints.reduce(reduceToIDs, new Array(this.hardpoints.length)).join('');
    }
    return this.serialized.hardpoints;
  }

  /**
   * Serializes the modifications to a string
   * @return {String} Serialized modifications 'code'
   */
  getModificationsString() {
    // Modifications can be updated outside of the ship's direct knowledge, for example when sliders change the value,
    // so always recreate it from scratch
    this.updateModificationsString();
    return this.serialized.modifications;
  }

  /**
   * Get the serialized module active/inactive settings
   * @return {String} Serialized active/inactive settings
   */
  getPowerEnabledString() {
    return this.serialized.enabled;
  }

  /**
   * Get the serialized module priority settings
   * @return {String} Serialized priority settings
   */
  getPowerPrioritiesString() {
    return this.serialized.priorities;
  }

  /* Mutate / Update Ship */

  /**
   * Recalculate all item costs and total based on discounts.
   * @param  {Number} shipDiscount      Ship cost discount (e.g. 0.1 === 10% discount)
   * @param  {Number} moduleDiscount    Module cost discount (e.g. 0.75 === 25% discount)
   * @return {this} The current ship instance for chaining
   */
  applyDiscounts(shipDiscount, moduleDiscount) {
    let shipCostMultiplier = 1 - shipDiscount;
    let moduleCostMultiplier = 1 - moduleDiscount;
    let total = 0;
    let costList = this.costList;

    for (let i = 0, l = costList.length; i < l; i++) {
      let item = costList[i];
      if (item.m && item.m.cost) {
        item.discountedCost = item.m.cost * (item.type == 'SHIP' ? shipCostMultiplier : moduleCostMultiplier);
        if (item.incCost) {
          total += item.discountedCost;
        }
      }
    }
    this.moduleCostMultiplier = moduleCostMultiplier;
    this.totalCost = total;
    return this;
  }

  /**
   * Set a modification value
   * @param {Object} m The module to change
   * @param {Object} name The name of the modification to change
   * @param {Number} value The new value of the modification
   */
  setModification(m, name, value) {
    // Handle special cases
    if (name == 'pgen') {
      // Power generation
      m.setModValue(name, value);
      this.updatePowerGenerated();
    } else if (name == 'power') {
      // Power usage
      m.setModValue(name, value);
      this.updatePowerUsed();
    } else if (name == 'mass') {
      // Mass
      let oldMass = m.getMass();
      m.setModValue(name, value);
      let newMass = m.getMass();
      this.unladenMass = this.unladenMass - oldMass + newMass;
      this.ladenMass = this.ladenMass - oldMass + newMass;
      this.updateTopSpeed();
      this.updateJumpStats();
    } else if (name == 'maxfuel') {
      m.setModValue(name, value);
      this.updateJumpStats();
    } else if (name == 'optmass') {
      m.setModValue(name, value);
      // Could be for either thrusters or FSD
      this.updateTopSpeed();
      this.updateJumpStats();
    } else if (name == 'optmul') {
      m.setModValue(name, value);
      // Could be for either thrusters or FSD
      this.updateTopSpeed();
      this.updateJumpStats();
    } else if (name == 'shieldboost') {
      m.setModValue(name, value);
      this.updateShield();
    } else if (name == 'hullboost') {
      m.setModValue(name, value);
      this.updateArmour();
    } else {
      // Generic
      m.setModValue(name, value);
    }
  }

  /**
   * Builds/Updates the ship instance with the ModuleUtils[comps] passed in.
   * @param {Object} comps Collection of ModuleUtils used to build the ship
   * @param {array} priorities Slot priorities
   * @param {Array} enabled    Slot active/inactive
   * @param {Array} mods       Modifications
   * @return {this} The current ship instance for chaining
   */
  buildWith(comps, priorities, enabled, mods) {
    let internal = this.internal,
        standard = this.standard,
        hps = this.hardpoints,
        cl = standard.length,
        i, l;

    // Reset Cumulative stats
    this.fuelCapacity = 0;
    this.cargoCapacity = 0;
    this.ladenMass = 0;
    this.armour = this.baseArmour;
    this.shield = this.baseShieldStrength;
    this.totalCost = this.m.incCost ? this.m.discountedCost : 0;
    this.unladenMass = this.hullMass;
    this.totalDps = 0;
    this.totalEps = 0;
    this.totalHps = 0;
    this.shieldExplRes = 0;
    this.shieldKinRes = 0;
    this.shieldThermRes = 0;
    this.hullExplRes = 0;
    this.hullKinRes = 0;
    this.hullThermRes = 0;

    this.bulkheads.m = null;
    this.useBulkhead(comps && comps.bulkheads ? comps.bulkheads : 0, true);
    this.bulkheads.m.mods = mods && mods[0] ? mods[0] : {};
    this.cargoHatch.priority = priorities ? priorities[0] * 1 : 0;
    this.cargoHatch.enabled = enabled ? enabled[0] * 1 : true;
    this.cargoHatch.mods = mods ? mods[0] : {};

    for (i = 0; i < cl; i++) {
      standard[i].cat = 0;
      standard[i].enabled = enabled ? enabled[i + 1] * 1 : true;
      standard[i].priority = priorities && priorities[i + 1] ? priorities[i + 1] * 1 : 0;
      standard[i].type = 'SYS';
      standard[i].m = null; // Resetting 'old' modul if there was one
      standard[i].discountedCost = 0;
      if (comps) {
        let module = ModuleUtils.standard(i, comps.standard[i]);
        if (module != null) { module.mods = mods && mods[i + 1] ? mods[i + 1] : {}; }
        this.use(standard[i], module, true);
      }
    }

    standard[1].type = 'ENG'; // Thrusters
    standard[2].type = 'ENG'; // FSD
    cl++; // Increase accounts for Cargo Scoop

    for (i = 0, l = hps.length; i < l; i++) {
      hps[i].cat = 1;
      hps[i].enabled = enabled ? enabled[cl + i] * 1 : true;
      hps[i].priority = priorities && priorities[cl + i] ? priorities[cl + i] * 1 : 0;
      hps[i].type = hps[i].maxClass ? 'WEP' : 'SYS';
      hps[i].m = null; // Resetting 'old' modul if there was one
      hps[i].discountedCost = 0;

      if (comps && comps.hardpoints[i] !== 0) {
        let module = ModuleUtils.hardpoints(comps.hardpoints[i]);
        if (module != null) { module.mods = mods && mods[cl + i] ? mods[cl + i] : {}; }
        this.use(hps[i], module, true);
      }
    }

    cl += hps.length; // Increase accounts for hardpoints

    for (i = 0, l = internal.length; i < l; i++) {
      internal[i].cat = 2;
      internal[i].enabled = enabled ? enabled[cl + i] * 1 : true;
      internal[i].priority = priorities && priorities[cl + i] ? priorities[cl + i] * 1 : 0;
      internal[i].type = 'SYS';
      internal[i].m = null; // Resetting 'old' modul if there was one
      internal[i].discountedCost = 0;

      if (comps && comps.internal[i] !== 0) {
        let module = ModuleUtils.internal(comps.internal[i]);
        if (module != null) { module.mods = mods && mods[cl + i] ? mods[cl + i] : {}; }
        this.use(internal[i], module, true);
      }
    }

    // Update aggragated stats
    if (comps) {
      this.updatePowerGenerated()
          .updatePowerUsed()
          .updateJumpStats()
          .updateShield()
          .updateArmour()
          .updateTopSpeed();
    }

    return this.updatePowerPrioritesString().updatePowerEnabledString().updateModificationsString();
  }

  /**
   * Updates an existing ship instance's slots with modules determined by the
   * code.
   *
   * @param {String}  serializedString  The string to deserialize
   * @return {this} The current ship instance for chaining
   */
  buildFrom(serializedString) {
    let standard = new Array(this.standard.length),
        hardpoints = new Array(this.hardpoints.length),
        internal = new Array(this.internal.length),
        mods = new Array(1 + this.standard.length + this.hardpoints.length + this.internal.length),
        parts = serializedString.split('.'),
        priorities = null,
        enabled = null,
        code = parts[0];

    if (parts[1]) {
      enabled = LZString.decompressFromBase64(parts[1].replace(/-/g, '/')).split('');
    }

    if (parts[2]) {
      priorities = LZString.decompressFromBase64(parts[2].replace(/-/g, '/')).split('');
    }

    if (parts[3]) {
      const modstr = parts[3].replace(/-/g, '/');
      if (modstr.match(':')) {
        this.decodeModificationsString(modstr, mods);
      } else {
        try {
          this.decodeModificationsStruct(zlib.gunzipSync(new Buffer(modstr, 'base64')), mods);
        } catch (err) {
          // Could be out-of-date URL; ignore
        }
      }
    }

    decodeToArray(code, internal, decodeToArray(code, hardpoints, decodeToArray(code, standard, 1)));

    return this.buildWith(
      {
        bulkheads: code.charAt(0) * 1,
        standard,
        hardpoints,
        internal
      },
      priorities,
      enabled,
      mods
    );
  };

  /**
   * Empties all hardpoints and utility slots
   * @return {this} The current ship instance for chaining
   */
  emptyHardpoints() {
    for (let i = this.hardpoints.length; i--;) {
      this.use(this.hardpoints[i], null);
    }
    return this;
  }

  /**
   * Empties all Internal slots
   * @return {this} The current ship instance for chaining
   */
  emptyInternal() {
    for (let i = this.internal.length; i--;) {
      this.use(this.internal[i], null);
    }
    return this;
  }

  /**
   * Empties all Utility slots
   * @return {this} The current ship instance for chaining
   */
  emptyUtility() {
    for (let i = this.hardpoints.length; i--;) {
      if (!this.hardpoints[i].maxClass) {
        this.use(this.hardpoints[i], null);
      }
    }
    return this;
  }

  /**
   * Empties all hardpoints
   * @return {this} The current ship instance for chaining
   */
  emptyWeapons() {
    for (let i = this.hardpoints.length; i--;) {
      if (this.hardpoints[i].maxClass) {
        this.use(this.hardpoints[i], null);
      }
    }
    return this;
  }

  /**
   * Optimize for the lower mass build that can still boost and power the ship
   * without power management.
   * @param  {Object} m Standard Module overrides
   * @return {this} The current ship instance for chaining
   */
  optimizeMass(m) {
    return this.emptyHardpoints().emptyInternal().useLightestStandard(m);
  }

  /**
   * Include/Exclude a item/slot in cost calculations
   * @param {Object} item       Slot or item
   * @param {boolean} included  Cost included
   * @return {this} The current ship instance for chaining
   */
  setCostIncluded(item, included) {
    if (item.incCost != included && item.m) {
      this.totalCost += included ? item.discountedCost : -item.discountedCost;
    }
    item.incCost = included;
    return this;
  }

  /**
   * Set slot active/inactive
   * @param {Object} slot    Slot model
   * @param {boolean} enabled  True - active
   * @return {this} The current ship instance for chaining
   */
  setSlotEnabled(slot, enabled) {
    if (slot.enabled != enabled) { // Enabled state is changing
      slot.enabled = enabled;
      if (slot.m) {
        if (ModuleUtils.isShieldGenerator(slot.m.grp) || slot.m.grp == 'sb') {
          this.updateShield();
        }
        if (slot.m.getDps()) {
          this.totalDps += slot.m.getDps() * (enabled ? 1 : -1);
        }
        if (slot.m.getEps()) {
          this.totalEps += slot.m.getEps() * (enabled ? 1 : -1);
        }
        if (slot.m.getHps()) {
          this.totalHps += slot.m.getHps() * (enabled ? 1 : -1);
        }

        this.updatePowerUsed();
        this.updatePowerEnabledString();
      }
    }
    return this;
  }

  /**
   * Will change the priority of the specified slot if the new priority is valid
   * @param  {Object} slot        The slot to be updated
   * @param  {Number} newPriority The new priority to be set
   * @return {boolean}            Returns true if the priority was changed (within range)
   */
  setSlotPriority(slot, newPriority) {
    if (newPriority >= 0 && newPriority < this.priorityBands.length) {
      let oldPriority = slot.priority;
      slot.priority = newPriority;
      this.updatePowerPrioritesString();

      if (slot.enabled) { // Only update power if the slot is enabled
        this.updatePowerUsed();
      }
      return true;
    }
    return false;
  }

  /**
   * Updates the ship's cumulative and aggregated stats based on the module change.
   * @param  {Object} slot            The slot being updated
   * @param  {Object} n               The new module (may be null)
   * @param  {Object} old             The old module (may be null)
   * @param  {boolean} preventUpdate  If true the global ship state will not be updated
   * @return {this}                   The ship instance (for chaining operations)
   */
  updateStats(slot, n, old, preventUpdate) {
    let powerGeneratedChange = slot == this.standard[0];
    let powerUsedChange = false;

    let armourChange = (slot == this.bulkheads) || (n && n.grp == 'hr') || (old && old.grp == 'hr');

    let shieldChange = (n && n.grp == 'bsg') || (old && old.grp == 'bsg') || (n && n.grp == 'psg') || (old && old.grp == 'psg') || (n && n.grp == 'sg') || (old && old.grp == 'sg') || (n && n.grp == 'sb') || (old && old.grp == 'sb');

    if (old) {  // Old modul now being removed
      switch (old.grp) {
        case 'ft':
          this.fuelCapacity -= old.fuel;
          break;
        case 'cr':
          this.cargoCapacity -= old.cargo;
          break;
      }

      if (slot.incCost && old.cost) {
        this.totalCost -= old.cost * this.moduleCostMultiplier;
      }

      if (old.getPowerUsage() > 0 && slot.enabled) {
        powerUsedChange = true;
      }

      if (old.getDps()) {
        this.totalDps -= old.getDps();
      }
      if (old.getEps()) {
        this.totalEps -= old.getEps();
      }
      if (old.getHps()) {
        this.totalHps -= old.getHps();
      }

      this.unladenMass -= old.getMass() || 0;
    }

    if (n) {
      switch (n.grp) {
        case 'ft':
          this.fuelCapacity += n.fuel;
          break;
        case 'cr':
          this.cargoCapacity += n.cargo;
          break;
      }

      if (slot.incCost && n.cost) {
        this.totalCost += n.cost * this.moduleCostMultiplier;
      }

      if (n.power && slot.enabled) {
        powerUsedChange = true;
      }

      if (n.getDps()) {
        this.totalDps += n.getDps();
      }
      if (n.getEps()) {
        this.totalEps += n.getEps();
      }
      if (n.getHps()) {
        this.totalHps += n.getHps();
      }

      this.unladenMass += n.getMass() || 0;
    }

    this.ladenMass = this.unladenMass + this.cargoCapacity + this.fuelCapacity;

    if (!preventUpdate) {
      if (powerGeneratedChange) {
        this.updatePowerGenerated();
      }
      if (powerUsedChange) {
        this.updatePowerUsed();
      }
      if (armourChange) {
        this.updateArmour();
      }
      if (shieldChange) {
        this.updateShield();
      }
      this.updateTopSpeed();
      this.updateJumpStats();
    }
    return this;
  }

  /**
   * Update power calculations when amount generated changes
   * @return {this} The ship instance (for chaining operations)
   */
  updatePowerGenerated() {
    this.powerAvailable = this.standard[0].m.getPowerGeneration();
    return this;
  };

  /**
   * Update power calculations when amount consumed changes
   * @return {this} The ship instance (for chaining operations)
   */
  updatePowerUsed() {
    let bands = [
      { deployed: 0, retracted: 0, },
      { deployed: 0, retracted: 0, },
      { deployed: 0, retracted: 0, },
      { deployed: 0, retracted: 0, },
      { deployed: 0, retracted: 0, }
    ];

    if (this.cargoHatch.enabled) {
      bands[this.cargoHatch.priority].retracted += this.cargoHatch.m.getPowerUsage();
    }

    for (let slotNum in this.standard) {
      const slot = this.standard[slotNum];
      if (slot.m && slot.enabled) {
        bands[slot.priority][powerUsageType(slot, slot.m)] += slot.m.getPowerUsage();
      }
    }

    for (let slotNum in this.internal) {
      const slot = this.internal[slotNum];
      if (slot.m && slot.enabled) {
        bands[slot.priority][powerUsageType(slot, slot.m)] += slot.m.getPowerUsage();
      }
    }

    for (let slotNum in this.hardpoints) {
      const slot = this.hardpoints[slotNum];
      if (slot.m && slot.enabled) {
        bands[slot.priority][powerUsageType(slot, slot.m)] += slot.m.getPowerUsage();
      }
    }

    // Work out the running totals
    let prevRetracted = 0, prevDeployed = 0;
    for (let i = 0, l = bands.length; i < l; i++) {
      let band = bands[i];
      prevRetracted = band.retractedSum = prevRetracted + band.retracted;
      prevDeployed = band.deployedSum = prevDeployed + band.deployed + band.retracted;
    }

    // Update global stats
    this.powerRetracted = prevRetracted;
    this.powerDeployed = prevDeployed;
    this.priorityBands = bands;

    return this;
  }

  /**
   * Update top speed and boost
   * @return {this} The ship instance (for chaining operations)
   */
  updateTopSpeed() {
    let speeds = Calc.speed(this.unladenMass + this.fuelCapacity, this.speed, this.boost, this.standard[1].m, this.pipSpeed);
    this.topSpeed = speeds['4 Pips'];
    this.topBoost = this.canBoost() ? speeds.boost : 0;
    return this;
  }

  /**
   * Update shield
   * @return {this} The ship instance (for chaining operations)
   */
  updateShield() {
    // Base shield from generator
    let baseShield = 0;
    let sgSlot = this.findInternalByGroup('sg');
    if (sgSlot && sgSlot.enabled) {
      baseShield = Calc.shieldStrength(this.hullMass, this.baseShieldStrength, sgSlot.m, 1);
    }

    let shield = baseShield;

    // Shield from boosters
    for (let slot of this.hardpoints) {
      if (slot.m && slot.m.grp == 'sb') {
        shield += baseShield * slot.m.getShieldBoost();
      }
    }
    this.shield = shield;
    return this;
  }

  /**
   * Update armour
   * @return {this} The ship instance (for chaining operations)
   */
  updateArmour() {
    // Armour from bulkheads
    let bulkhead = this.bulkheads.m;
    let armour = this.baseArmour + (this.baseArmour * bulkhead.getHullBoost());

    // Armour from HRPs
    for (let slot of this.internal) {
      if (slot.m && slot.m.grp == 'hr') {
        armour += slot.m.getHullReinforcement();
        // Hull boost for HRPs is applied against the ship's base armour
        armour += this.baseArmour * slot.m.getModValue('hullboost');
      }
    }
    this.armour = armour;
    return this;
  }

  /**
   * Jump Range and total range calculations
   * @return {this} The ship instance (for chaining operations)
   */
  updateJumpStats() {
    let fsd = this.standard[2].m;   // Frame Shift Drive;
    let { unladenMass, fuelCapacity } = this;
    this.unladenRange = this.calcUnladenRange(); // Includes fuel weight for jump
    this.fullTankRange = Calc.jumpRange(unladenMass + fuelCapacity, fsd); // Full Tank
    this.ladenRange = this.calcLadenRange(); // Includes full tank and caro
    this.unladenFastestRange = Calc.fastestRange(unladenMass, fsd, fuelCapacity);
    this.ladenFastestRange = Calc.fastestRange(unladenMass + this.cargoCapacity, fsd, fuelCapacity);
    this.maxJumpCount = Math.ceil(fuelCapacity / fsd.maxfuel);
    return this;
  }

  /**
   * Update the serialized power priorites string
   * @return {this} The ship instance (for chaining operations)
   */
  updatePowerPrioritesString() {
    let priorities = [this.cargoHatch.priority];

    for (let slot of this.standard) {
      priorities.push(slot.priority);
    }
    for (let slot of this.hardpoints) {
      priorities.push(slot.priority);
    }
    for (let slot of this.internal) {
      priorities.push(slot.priority);
    }

    this.serialized.priorities = LZString.compressToBase64(priorities.join('')).replace(/\//g, '-');
    return this;
  }

  /**
   * Update the serialized power active/inactive string
   * @return {this} The ship instance (for chaining operations)
   */
  updatePowerEnabledString() {
    let enabled = [this.cargoHatch.enabled ? 1 : 0];

    for (let slot of this.standard) {
      enabled.push(slot.enabled ? 1 : 0);
    }
    for (let slot of this.hardpoints) {
      enabled.push(slot.enabled ? 1 : 0);
    }
    for (let slot of this.internal) {
      enabled.push(slot.enabled ? 1 : 0);
    }

    this.serialized.enabled = LZString.compressToBase64(enabled.join('')).replace(/\//g, '-');
    return this;
  }

  /**
   * Update the modifications string
   * @return {this} The ship instance (for chaining operations)
   */
  oldupdateModificationsString() {
    let allMods = new Array();

    let bulkheadMods = new Array();
    if (this.bulkheads.m && this.bulkheads.m.mods) {
      for (let modKey in this.bulkheads.m.mods) {
        bulkheadMods.push(Modifications.modifiers.indexOf(modKey) + ':' + Math.round(this.bulkheads.m.getModValue(modKey) * 10000));
      }
    }
    allMods.push(bulkheadMods.join(';'));

    for (let slot of this.standard) {
      let slotMods = new Array();
      if (slot.m && slot.m.mods) {
        for (let modKey in slot.m.mods) {
          slotMods.push(Modifications.modifiers.indexOf(modKey) + ':' + Math.round(slot.m.getModValue(modKey) * 10000));
        }
      }
      allMods.push(slotMods.join(';'));
    }
    for (let slot of this.hardpoints) {
      let slotMods = new Array();
      if (slot.m && slot.m.mods) {
        for (let modKey in slot.m.mods) {
          slotMods.push(Modifications.modifiers.indexOf(modKey) + ':' + Math.round(slot.m.getModValue(modKey) * 10000));
        }
      }
      allMods.push(slotMods.join(';'));
    }
    for (let slot of this.internal) {
      let slotMods = new Array();
      if (slot.m && slot.m.mods) {
        for (let modKey in slot.m.mods) {
          slotMods.push(Modifications.modifiers.indexOf(modKey) + ':' + Math.round(slot.m.getModValue(modKey) * 10000));
        }
      }
      allMods.push(slotMods.join(';'));
    }
    this.serialized.modifications = LZString.compressToBase64(allMods.join(',').replace(/,+$/, '')).replace(/\//g, '-');
    return this;
  }

  /**
   * Populate the modifications array with modification values from the code
   * @param {String} code    Serialized modification code
   * @param {Array}  arr     Modification array
   */
  decodeModificationsString(code, arr) {
    let moduleMods = code.split(',');
    for (let i = 0; i < arr.length; i++) {
      arr[i] = {};
      if (moduleMods.length > i && moduleMods[i] != '') {
        let mods = moduleMods[i].split(';');
        for (let j = 0; j < mods.length; j++) {
          let modElements = mods[j].split(':');
          if (modElements[0].match('[0-9]+')) {
            arr[i][Modifications.modifiers[modElements[0]]] = Number(modElements[1]);
          } else {
            arr[i][modElements[0]] = Number(modElements[1]);
          }
        }
      }
    }
  }

  /**
   * Update the modifications string.
   * This is a binary structure.  It starts with a byte that identifies a slot, with bulkheads being ID 0 and moving through
   * standard modules, hardpoints, and finally internal modules.  It then contains one or more modifications, with each
   * modification being a one-byte modification ID and at two-byte modification value.  Modification IDs are based on the array
   * in Modifications.modifiers.  The list of modifications is terminated by a modification ID of -1.  The structure then repeats
   * for the next module, and the next, and is terminated by a slot ID of -1.
   * @return {this} The ship instance (for chaining operations)
   */
  updateModificationsString() {
    // Start off by gathering the information that we need
    let slots = new Array();

    let bulkheadMods = new Array();
    if (this.bulkheads.m && this.bulkheads.m.mods) {
      for (let modKey in this.bulkheads.m.mods) {
        bulkheadMods.push({ id: Modifications.modifiers.indexOf(modKey), value: Math.round(this.bulkheads.m.getModValue(modKey) * 10000) });
      }
    }
    slots.push(bulkheadMods);

    for (let slot of this.standard) {
      let slotMods = new Array();
      if (slot.m && slot.m.mods) {
        for (let modKey in slot.m.mods) {
          slotMods.push({ id: Modifications.modifiers.indexOf(modKey), value: Math.round(slot.m.getModValue(modKey) * 10000) });
        }
      }
      slots.push(slotMods);
    }

    for (let slot of this.hardpoints) {
      let slotMods = new Array();
      if (slot.m && slot.m.mods) {
        for (let modKey in slot.m.mods) {
          slotMods.push({ id: Modifications.modifiers.indexOf(modKey), value: Math.round(slot.m.getModValue(modKey) * 10000) });
        }
      }
      slots.push(slotMods);
    }

    for (let slot of this.internal) {
      let slotMods = new Array();
      if (slot.m && slot.m.mods) {
        for (let modKey in slot.m.mods) {
          slotMods.push({ id: Modifications.modifiers.indexOf(modKey), value: Math.round(slot.m.getModValue(modKey) * 10000) });
        }
      }
      slots.push(slotMods);
    }

    // Now work out the size of the binary buffer from our modifications array
    let bufsize = 0;
    for (let slot of slots) {
      if (slot.length > 0) {
        bufsize = bufsize + 1 + (5 * slot.length) + 1;
      }
    }

    if (bufsize > 0) {
      bufsize = bufsize + 1; // For end marker
      // Now create and populate the buffer
      let buffer = Buffer.alloc(bufsize);
      let curpos = 0;
      let i = 0;
      for (let slot of slots) {
        if (slot.length > 0) {
          buffer.writeInt8(i, curpos++);
          for (let slotMod of slot) {
            buffer.writeInt8(slotMod.id, curpos++);
            buffer.writeInt32LE(slotMod.value, curpos);
            curpos += 4;
          }
          buffer.writeInt8(-1, curpos++);
        }
        i++;
      }
      if (curpos > 0) {
        buffer.writeInt8(-1, curpos++);
      }

      this.serialized.modifications = zlib.gzipSync(buffer).toString('base64').replace(/\//g, '-');
    } else {
      this.serialized.modifications = null;
    }
    return this;
  }

  /**
   * Populate the modifications array with modification values from the code.
   * See updateModificationsString() for details of the structure.
   * @param {String} buffer  Buffer holding modification info
   * @param {Array}  arr     Modification array
   */
  decodeModificationsStruct(buffer, arr) {
    let curpos = 0;
    let slot = buffer.readInt8(curpos++);
    while (slot != -1) {
      let modifications = {};
      let modificationId = buffer.readInt8(curpos++);
      while (modificationId != -1) {
        let modificationValue = buffer.readInt32LE(curpos);
        curpos += 4;
        modifications[Modifications.modifiers[modificationId]] = modificationValue;
        modificationId = buffer.readInt8(curpos++);
      }
      arr[slot] = modifications;
      slot = buffer.readInt8(curpos++);
    }
  }

  /**
   * Update a slot with a the modul if the id is different from the current id for this slot.
   * Has logic handling ModuleUtils that you may only have 1 of (Shield Generator or Refinery).
   *
   * @param {Object}  slot            The modul slot
   * @param {Object}  mdef            Properties for the selected modul
   * @param {boolean} preventUpdate   If true, do not update aggregated stats
   * @return {this} The ship instance (for chaining operations)
   */
  use(slot, mdef, preventUpdate) {
    // See if the module passed in is really a module or just a definition, and fix it accordingly so that we have a module instance
    let m;
    if (mdef == null) {
      m = null;
    } else if (mdef instanceof Module) {
      m = mdef;
    } else {
      m = new Module({ grp: mdef.grp, id: mdef.id });
    }

    if (slot.m != m) { // Selecting a different modul
      // Slot is an internal slot, is not being emptied, and the selected modul group/type must be of unique
      if (slot.cat == 2 && m && UNIQUE_MODULES.indexOf(m.grp) != -1) {
        // Find another internal slot that already has this type/group installed
        let similarSlot = this.findInternalByGroup(m.grp);
        // If another slot has an installed modul with of the same type
        if (!preventUpdate && similarSlot && similarSlot !== slot) {
          this.updateStats(similarSlot, null, similarSlot.m);
          similarSlot.m = null;  // Empty the slot
          similarSlot.discountedCost = 0;
        }
      }
      let oldModule = slot.m;
      slot.m = m;
      slot.discountedCost = (m && m.cost) ? m.cost * this.moduleCostMultiplier : 0;
      this.updateStats(slot, m, oldModule, preventUpdate);

      switch (slot.cat) {
        case 0: this.serialized.standard = null; break;
        case 1: this.serialized.hardpoints = null; break;
        case 2: this.serialized.internal = null;
      }
      this.serialized.modifications = null;
    }
    return this;
  }

  /**
   * Mount the specified bulkhead type (index)
   * @param  {Number} index           Bulkhead index [0-4]
   * @param  {boolean} preventUpdate  Prevent summary update
   * @return {this} The ship instance (for chaining operations)
   */
  useBulkhead(index, preventUpdate) {
    let oldBulkhead = this.bulkheads.m;
    this.bulkheads.m = this.availCS.getBulkhead(index);
    this.bulkheads.discountedCost = this.bulkheads.m.cost * this.moduleCostMultiplier;
    this.updateStats(this.bulkheads, this.bulkheads.m, oldBulkhead, preventUpdate);
    this.serialized.standard = null;
    return this;
  }

  /**
   * Set all standard slots to use the speficied rating and class based on
   * the slot's max class
   * @param  {String} rating Module Rating (A-E)
   * @return {this} The ship instance (for chaining operations)
   */
  useStandard(rating) {
    for (let i = this.standard.length - 1; i--;) { // All except Fuel Tank
      let id = this.standard[i].maxClass + rating;
      this.use(this.standard[i], ModuleUtils.standard(i, id));
    }
    return this;
  }

  /**
   * Use the lightest standard ModuleUtils unless otherwise specified
   * @param  {Object} m Module override set (standard type => module ID)
   * @return {this} The ship instance (for chaining operations)
   */
  useLightestStandard(m) {
    m = m || {};

    let standard = this.standard,
        // Find lightest Power Distributor that can still boost;
        pd = m.pd ? ModuleUtils.standard(4, m.pd) : this.availCS.lightestPowerDist(this.boostEnergy),
        fsd = ModuleUtils.standard(2, m.fsd || standard[2].maxClass + 'A'),
        ls = ModuleUtils.standard(3, m.ls || standard[3].maxClass + 'D'),
        s = ModuleUtils.standard(5, m.s || standard[5].maxClass + 'D'),
        ft = m.ft ? ModuleUtils.standard(6, m.ft) : standard[6].m, // Use existing fuel tank unless specified
        updated;

    this.useBulkhead(0)
        .use(standard[2], fsd)   // FSD
        .use(standard[3], ls)    // Life Support
        .use(standard[5], s)     // Sensors
        .use(standard[4], pd)    // Power Distributor
        .use(standard[6], ft);   // Fuel Tank

    // Thrusters and Powerplant must be determined after all other ModuleUtils are mounted
    // Loop at least once to determine absolute lightest PD and TH
    do {
      updated = false;
      // Find lightest Thruster that still works for the ship at max mass
      let th = m.th ? ModuleUtils.standard(1, m.th) : this.availCS.lightestThruster(this.ladenMass);
      if (!isEqual.isEqual(th, standard[1].m)) {
        this.use(standard[1], th);
        updated = true;
      }
      // Find lightest Power plant that can power the ship
      let pp = m.pp ? ModuleUtils.standard(0, m.pp) : this.availCS.lightestPowerPlant(Math.max(this.powerRetracted, this.powerDeployed), m.ppRating);

      if (!isEqual.isEqual(pp, standard[0].m)) {
        this.use(standard[0], pp);
        updated = true;
      }
    } while (updated);

    return this;
  }

  /**
   * Fill all utility slots with the specified module
   * @param  {String} group   Group name
   * @param  {String} rating  Rating [A-I]
   * @param  {String} name    Module name
   * @param  {boolean} clobber Overwrite non-empty slots
   * @return {this} The ship instance (for chaining operations)
   */
  useUtility(group, rating, name, clobber) {
    let m = ModuleUtils.findHardpoint(group, 0, rating, name);
    for (let i = this.hardpoints.length; i--;) {
      if ((clobber || !this.hardpoints[i].m) && !this.hardpoints[i].maxClass) {
        this.use(this.hardpoints[i], m);
      }
    }
    return this;
  }

  /**
   * [useWeapon description]
   * @param  {[type]} group   [description]
   * @param  {[type]} mount   [description]
   * @param  {[type]} missile [description]
   * @param  {boolean} clobber Overwrite non-empty slots
   * @return {this} The ship instance (for chaining operations)
   */
  useWeapon(group, mount, missile, clobber) {
    let hps = this.hardpoints;
    for (let i = hps.length; i--;) {
      if (hps[i].maxClass) {
        let size = hps[i].maxClass, m;
        do {
          m = ModuleUtils.findHardpoint(group, size, null, null, mount, missile);
          if ((clobber || !hps[i].m) && m) {
            this.use(hps[i], m);
            break;
          }
        } while (!m && (--size > 0));
      }
    }
    return this;
  }
}
