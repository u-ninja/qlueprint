import { useEffect, useRef, useState } from "react";
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from "@/components/ui/menubar";
import { useShallow } from "zustand/react/shallow";
import { useUi } from "@/stores/ui";
import { menus, useMenuShortcuts, type Actions, type MenuItem, type MenuState } from "./menu";
import { notBuilt } from "./PendingAction";

const itemClass = "text-[13px]";

type ItemProps = { item: MenuItem; actions: Actions; state: MenuState; onSelect: (id: string) => void };

function Item({ item, actions, state, onSelect }: ItemProps) {
  const built = item.id in actions;
  const content = (
    <>
      {item.label}
      {item.keys && <MenubarShortcut className="pl-6 tracking-normal">{item.keys}</MenubarShortcut>}
    </>
  );
  if (!built) {
    // Same "not built yet" treatment as PendingAction; pointer events stay on so the title shows
    return (
      <MenubarItem inset disabled title={notBuilt} aria-description={notBuilt} className={`${itemClass} data-disabled:pointer-events-auto`}>
        {content}
      </MenubarItem>
    );
  }
  if (item.checked) {
    return (
      <MenubarCheckboxItem checked={item.checked(state)} onSelect={() => onSelect(item.id)} className={itemClass}>
        {content}
      </MenubarCheckboxItem>
    );
  }
  return (
    <MenubarItem inset onSelect={() => onSelect(item.id)} className={itemClass}>
      {content}
    </MenubarItem>
  );
}

/**
 * The in-app menu bar for Windows and Linux. Keyboard: Alt focuses it (Alt again or Esc goes back),
 * Alt+letter opens a menu, arrows move between menus and items.
 */
export function AppMenu({ actions }: { actions: Actions }) {
  const state = useUi(useShallow(({ sidebarOpen, inspectorOpen, theme }) => ({ sidebarOpen, inspectorOpen, theme })));
  useMenuShortcuts(actions);
  const [open, setOpen] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  // Where focus was before the menu took it, so Edit items act on that field and Esc returns there
  const previousFocus = useRef<HTMLElement | null>(null);
  const picked = useRef(false);

  const focusMenu = (label: string) => rootRef.current?.querySelector<HTMLElement>(`[data-menu="${label}"]`)?.focus();
  const leaveMenu = () => {
    setOpen("");
    previousFocus.current?.focus();
  };

  useEffect(() => {
    // Alt pressed and released alone toggles focus, like a native menu bar
    let altAlone = false;
    function onKeyDown(event: KeyboardEvent) {
      altAlone = event.key === "Alt" && !event.repeat;
      if (!event.altKey || event.ctrlKey || event.metaKey || event.key.length !== 1) return;
      const menu = menus.find((m) => m.label[0].toLowerCase() === event.key.toLowerCase());
      if (!menu) return;
      event.preventDefault();
      focusMenu(menu.label);
      setOpen(menu.label);
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.key !== "Alt" || !altAlone) return;
      altAlone = false;
      event.preventDefault();
      if (rootRef.current?.contains(document.activeElement)) leaveMenu();
      else focusMenu(menus[0].label);
    }
    // Alt+click is multi-cursor in the editor, not a menu toggle
    const cancel = () => (altAlone = false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointerdown", cancel);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointerdown", cancel);
    };
  }, []);

  function select(id: string) {
    picked.current = true;
    previousFocus.current?.focus();
    actions[id]?.();
  }

  return (
    <Menubar
      ref={rootRef}
      value={open}
      onValueChange={setOpen}
      onFocus={(event) => {
        const from = event.relatedTarget;
        if (from instanceof HTMLElement && !rootRef.current?.contains(from) && !from.closest("[data-slot^=menubar]")) {
          previousFocus.current = from;
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !open) leaveMenu();
      }}
      className="h-auto gap-0 rounded-none border-0 p-0"
    >
      {menus.map((menu) => (
        <MenubarMenu key={menu.label} value={menu.label}>
          <MenubarTrigger
            data-menu={menu.label}
            className="h-7 rounded-md px-2 py-0 text-[13px] font-normal text-fg2 hover:bg-hover hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
          >
            {menu.label}
          </MenubarTrigger>
          <MenubarContent
            alignOffset={0}
            sideOffset={6}
            className="min-w-52"
            onCloseAutoFocus={(event) => {
              // After picking an item, focus stays where the action left it instead of on the trigger
              if (picked.current) event.preventDefault();
              picked.current = false;
            }}
          >
            {menu.entries.map((entry, i) => {
              if (entry === "separator") return <MenubarSeparator key={i} />;
              if ("id" in entry) return <Item key={entry.id} item={entry} actions={actions} state={state} onSelect={select} />;
              return (
                <MenubarSub key={entry.label}>
                  <MenubarSubTrigger inset className={itemClass}>{entry.label}</MenubarSubTrigger>
                  <MenubarSubContent className="min-w-40">
                    <MenubarRadioGroup value={entry.selected(state)} onValueChange={select}>
                      {entry.items.map((item) => (
                        <MenubarRadioItem key={item.id} value={item.id} className={itemClass}>
                          {item.label}
                        </MenubarRadioItem>
                      ))}
                    </MenubarRadioGroup>
                  </MenubarSubContent>
                </MenubarSub>
              );
            })}
          </MenubarContent>
        </MenubarMenu>
      ))}
    </Menubar>
  );
}
