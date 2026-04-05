# Figma Design System Build — Essential Rules

## use_figma Rules (MUST follow)

- **Return data**: Use ONLY `return` statements. No `figma.closePlugin()`, `console.log()`, or `figma.notify()`.
- **Async/Await**: All async operations MUST be awaited. Top-level await is supported.
- **Colors**: Use 0–1 range, NOT 0–255. Example: `{r: 0.2, g: 0.4, b: 1}`.
- **Page switching**: Use `await figma.setCurrentPageAsync(page)`, NOT `figma.currentPage = page`.
- **Fills/Strokes**: Read-only arrays. Clone, modify, reassign: `node.fills = [{...node.fills[0], color: newColor}]`.
- **Font loading**: Call `await figma.loadFontAsync(node.fontName)` before any text operations.
- **Layout sizing**: Set `layoutSizingHorizontal/Vertical = 'FILL'` AFTER `parent.appendChild(child)`.
- **Always pass `skillNames: "figma-use"`** when calling `use_figma`.

## Component Patterns

### Importing and Instantiating
```js
// Import a component set by key
const componentSet = await figma.importComponentSetByKeyAsync("COMPONENT_KEY");
// Get the default variant
const defaultVariant = componentSet.defaultVariant;
// Create an instance
const instance = defaultVariant.createInstance();
parent.appendChild(instance);
```

### Reading Component Properties
```js
// Read properties from an instance
const props = instance.componentProperties;
// Set text property (key comes from componentProperties)
instance.setProperties({ "Label#2:0": "New Text" });
```

### Specific Variant Selection
```js
const children = componentSet.children;
const variant = children.find(c => c.name.includes("Size=Large"));
const instance = variant.createInstance();
```

## Variable Patterns

### Importing and Binding
```js
// Import a variable by key
const colorVar = await figma.variables.importVariableByKeyAsync("VARIABLE_KEY");

// Bind to fills (colors)
const fills = JSON.parse(JSON.stringify(node.fills));
fills[0] = figma.variables.setBoundVariableForPaint(fills[0], 'color', colorVar);
node.fills = fills;

// Bind to spacing/radii
node.setBoundVariable('paddingTop', spacingVar);
node.setBoundVariable('paddingBottom', spacingVar);
node.setBoundVariable('itemSpacing', gapVar);
node.setBoundVariable('topLeftRadius', radiusVar);
```

### Variable Discovery
- `search_design_system` with `includeVariables: true` searches across ALL linked libraries.
- `figma.variables.getLocalVariableCollectionsAsync()` only returns LOCAL variables — not library variables.
- Always use `search_design_system` first.

## Auto Layout
```js
frame.layoutMode = "VERTICAL"; // or "HORIZONTAL"
frame.primaryAxisSizingMode = "AUTO";
frame.counterAxisSizingMode = "FIXED";
frame.paddingTop = frame.paddingBottom = 24;
frame.paddingLeft = frame.paddingRight = 24;
frame.itemSpacing = 16;
// FILL sizing must be set AFTER appendChild
child.layoutSizingHorizontal = "FILL";
```

## Common Gotchas

1. **Never hardcode colors** — always bind variables.
2. **Clone fills before modifying**: `node.fills = [{...}]` not `node.fills[0].color = x`.
3. **Font must be loaded** before setting `node.characters` or `node.fontSize`.
4. **`layoutSizingHorizontal = 'FILL'`** only works after the node is a child of an auto-layout frame.
5. **`figma.notify()` throws** "not implemented" — never use it.
6. **Return node IDs** from every `use_figma` call for tracking.
7. **Component property keys** are auto-generated strings like `"Label#2:0"` — read from `componentProperties`, never hardcode.
8. **`setBoundVariableForPaint`** returns the new paint — you must reassign: `fills[0] = figma.variables.setBoundVariableForPaint(fills[0], 'color', v)`.

## Workflow for Building a Screen

1. **Discover**: Use `search_design_system` with multiple search terms to find components and variables.
2. **Create wrapper frame**: Single `use_figma` call, 1440px wide, vertical auto-layout.
3. **Build sections**: One `use_figma` call per major section. Import components by key, create instances, bind variables.
4. **Validate**: Use `get_screenshot` to check the result if needed.
