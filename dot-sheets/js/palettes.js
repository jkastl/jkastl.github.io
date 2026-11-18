/* Marker sets for Lifelines FlowArt Dot-by-Letter kits, as best we can tell from the outside.
 *
 * Lifelines doesn't publish ink colors or names. Each hex below was sampled from the colored dot on
 * the marker caps in the product photos on lifelines.com (November 2026), unless the entry says
 * `est: true` (read by eye where the sampler missed it). The names are ours, not Lifelines'. Photo
 * colors run a little off from real ink, and metallic inks can't be shown as one flat color at all,
 * so treat these as close starting points: every color can be edited in the app.
 *
 * Every full-size kit has 4 double-sided markers (8 colors). Kits don't fix which letter gets which
 * color: you fill in the key at the top of each page. 8-color pages use the letters B D F G H V X Z.
 *
 * Mini Express pads (sold at Target and Walmart: 15 scenes, 5 single markers) are different: every
 * page's key prints each letter next to a fixed color, so those entries carry `letter`, and a page
 * made from one pad's markers keeps the pad's own letters. Their hexes were sampled from the dotted
 * ink in Target's close-up product photos (November 2026), which is closer to real ink than a cap.
 *
 * Classic script: attaches to globalThis.DotPalettes.
 */
(function (P) {
  'use strict';

  const c = (name, hex, est) => (est ? { name, hex, est: true } : { name, hex });
  const m = (letter, name, hex) => ({ name, hex, letter });

  const SETS = [
    { id: 'landscapes', name: 'Landscapes', colors: [
      c('Purple', '#765fa8'), c('Brown', '#5f422f'), c('Green', '#26b158'), c('Orange', '#f5863e'),
      c('Pink', '#f0739f'), c('Red', '#cb212e'), c('Teal', '#43c0b2'), c('Blue', '#2c86c8')] },
    { id: 'botanicals', name: 'Botanicals', colors: [
      c('Purple', '#765ea8'), c('Brown', '#614230'), c('Green', '#25b15a'), c('Orange', '#f6853e'),
      c('Pink', '#f174a2'), c('Red', '#cc2032'), c('Teal', '#43c2b0'), c('Blue', '#2d85c7')] },
    { id: 'cozy-cottage', name: 'Cozy Cottage', colors: [
      c('Lavender', '#bb9ccb'), c('Yellow', '#f6d308'), c('Deep Teal', '#0a7f86'), c('Green', '#56bd6f'),
      c('Red', '#e84759'), c('Pink', '#ed7aa5'), c('Sky Blue', '#79cbf0'), c('Rust', '#bf5528')] },
    { id: 'everyday-inspiration', name: 'Everyday Inspiration', colors: [
      c('Orange', '#faa133'), c('Sky Blue', '#79cdf3'), c('Deep Purple', '#53368a'), c('Red', '#cd2130'),
      c('Pink', '#ed79a6'), c('Lavender', '#b79bcb'), c('Green', '#50bc6b'), c('Deep Teal', '#0c8285')] },
    { id: 'wags-whiskers', name: 'Wags & Whiskers', colors: [
      c('Orange', '#f7a144'), c('Peach', '#fccdb2'), c('Black', '#080a09'), c('Lime', '#8ec643'),
      c('Light Blue', '#95daf4'), c('Rust Brown', '#c05827'), c('Light Pink', '#f9b0bc'), c('Lavender', '#c2a6d3', true)] },
    { id: 'day-at-the-beach', name: 'Day at the Beach', colors: [
      c('Brown', '#6f3227'), c('Olive', '#6a7631'), c('Blue', '#1255a3'), c('Red', '#d42e47'),
      c('Peach', '#f7c8ac'), c('Light Blue', '#a8dbf0'), c('Teal', '#37bead'), c('Orange', '#f59848')] },
    { id: 'pumpkins-pastures', name: 'Pumpkins & Pastures', colors: [
      c('Navy', '#3e4077'), c('Green', '#4eab7c'), c('Gold', '#e0bd67'), c('Brown', '#6e2e20'),
      c('Sky Blue', '#69caea'), c('Red', '#cd2031'), c('Plum', '#8f2d4e'), c('Orange', '#f6881f')] },
    { id: 'strolling-through-fall', name: 'Strolling Through Fall', colors: [
      c('Brown', '#72332d'), c('Olive', '#6a7c38'), c('Peach', '#efc6a6'), c('Burnt Orange', '#c06424'),
      c('Brick Red', '#9e3426'), c('Pink', '#eba3af'), c('Orange', '#eb9a42'), c('Periwinkle', '#99bce0')] },
    { id: 'spooky-season', name: 'Spooky Season', colors: [
      c('Brown', '#71322e'), c('Peach', '#f1c4a5'), c('Lavender', '#c4b6e0', true), c('Light Blue', '#77c9e7'),
      c('Orange', '#f68826'), c('Purple', '#6d4c9f'), c('Green', '#17ac69'), c('Black', '#050c15')] },
    { id: 'holiday-helpers', name: 'Holiday Helpers', colors: [
      c('Brown', '#783326'), c('Tan', '#d3ac6e'), c('Peach', '#fbd1b8'), c('Orange', '#f6a64e'),
      c('Red', '#e83f42'), c('Green', '#36b475'), c('Lavender', '#d6c4e6', true), c('Light Blue', '#9cd9ec')] },
    { id: 'the-north-pole', name: 'The North Pole', colors: [
      c('Brown', '#773426'), c('Black', '#020608'), c('Apricot', '#fbb88e'), c('Orange', '#f7a74f'),
      c('Red', '#e73535'), c('Pine Green', '#0e6c38'), c('Blue', '#206fb8'), c('Light Blue', '#99daed')] },
    { id: 'snowed-in', name: 'Snowed In', colors: [
      c('Green', '#2fb77d'), c('Pink', '#f171a2'), c('Sky Blue', '#75cef1'), c('Brown', '#6e2d20'),
      c('Deep Teal', '#0e818a'), c('Red', '#e0233e'), c('Purple', '#835ea4'), c('Orange', '#f6853e')] },
    { id: 'winters-glow', name: "Winter's Glow", metallic: true, colors: [
      c('Garnet', '#8e3440'), c('Copper', '#a76a44'), c('Green', '#308364'), c('Turquoise', '#18acce'),
      c('Silver', '#b9b9c8', true), c('Blue', '#295aa0'), c('Lilac', '#8f8dc6'), c('Gold', '#e7cc77')] },
    { id: 'into-the-deep', name: 'Into the Deep', metallic: true, colors: [
      c('Copper', '#b2683f'), c('Green', '#357f66'), c('Magenta', '#b4469f'), c('Blue', '#3077a4'),
      c('Gold', '#d1932c'), c('Lime', '#9eb363'), c('Burgundy', '#6a353a'), c('Lilac', '#8a83bf')] },
    { id: 'into-the-galaxy', name: 'Into the Galaxy', metallic: true, colors: [
      c('Silver', '#cfcfdc', true), c('Green', '#38876b'), c('Copper', '#b86a39'), c('Magenta', '#9f3877'),
      c('Gold', '#d0a13f'), c('Blue', '#2b559c'), c('Burgundy', '#702d37'), c('Lilac', '#9588c7')] },
    { id: 'moonlit-garden', name: 'Moonlit Garden', metallic: true, colors: [
      c('Gold', '#e8c46c'), c('Turquoise', '#0ea1cf'), c('Lime', '#a3ca58'), c('Magenta', '#902f65'),
      c('Lilac', '#9284bb'), c('Blue', '#1f5c9c'), c('Green', '#287762'), c('Silver', '#c8c8d4', true)] },
    { id: 'majestic-earth', name: 'Majestic Earth', metallic: true, colors: [
      c('Pale Lime', '#cbd79a'), c('Blue', '#22599e'), c('Copper', '#b86b38'), c('Gold', '#ce9b40'),
      c('Lilac', '#958ac5'), c('Green', '#388267'), c('Turquoise', '#22bee2'), c('Silver', '#c8c8d4', true)] },

    // Mini Express pads: 5 markers each, letters fixed by the pad's key (dark colors first).
    { id: 'snow-day', name: 'Snow Day', line: 'Mini Express', colors: [
      m('B', 'Brown', '#80342f'), m('F', 'Red', '#d93737'), m('H', 'Light Blue', '#8cd2e6'),
      m('V', 'Green', '#0fa665'), m('X', 'Navy', '#323665')] },
    { id: 'in-full-bloom', name: 'In Full Bloom', line: 'Mini Express', colors: [
      m('V', 'Dark Green', '#356039'), m('B', 'Pink', '#d8a1c4'), m('G', 'Gold', '#e7a53e'),
      m('H', 'Red', '#dd3243'), m('Z', 'Light Blue', '#a1c3de')] },
    { id: 'paws-and-purrs', name: 'Paws and Purrs', line: 'Mini Express', colors: [
      m('B', 'Dark Brown', '#5e322a'), m('F', 'Light Blue', '#8bc8de'), m('X', 'Green', '#67ac66'),
      m('G', 'Orange', '#e59145'), m('H', 'Peach', '#f2cdb4')] },
    { id: 'cozy-comforts', name: 'Cozy Comforts', line: 'Mini Express', colors: [
      m('H', 'Olive Green', '#495536'), m('Z', 'Rust Brown', '#974e3d'), m('B', 'Peach', '#edccb8'),
      m('D', 'Lavender', '#c9bbdc'), m('V', 'Orange', '#e98e42')] },
    { id: 'nature-walk', name: 'Nature Walk', line: 'Mini Express', colors: [
      m('B', 'Green', '#58a547'), m('D', 'Brown', '#683128'), m('V', 'Orange', '#ef8526'),
      m('X', 'Peach', '#f6ccb1'), m('Z', 'Light Blue', '#a2c4de')] },
    { id: 'merry-moments', name: 'Merry Moments', line: 'Mini Express', colors: [
      m('B', 'Red', '#cf453f'), m('X', 'Caramel', '#b0714e'), m('Z', 'Green', '#325935'),
      m('D', 'Peach', '#f4bc97'), m('F', 'Light Blue', '#87cee2')] },
  ];

  // Letter sets for the key. FlowArt's 8-color pages use B D F G H V X Z: shapes that stay
  // distinct even printed 2 mm tall in pale gray. Past 8 colors we keep picking unlike shapes.
  const LETTERS = {
    flowart: 'BDFGHVXZKMNPRSTW'.split(''),
    // Mini pads use five: F G H X Z.
    mini: 'FGHXZBDVKMNPRSTW'.split(''),
    alpha: 'ABCDEFGHJKLMNPRSTUVWXYZ'.split(''),
  };

  P.SETS = SETS;
  P.LETTERS = LETTERS;
  P.byId = id => SETS.find(s => s.id === id) || null;
})(typeof globalThis.DotPalettes === 'object' ? globalThis.DotPalettes : (globalThis.DotPalettes = {}));

if (typeof module === 'object' && module.exports) module.exports = globalThis.DotPalettes;
