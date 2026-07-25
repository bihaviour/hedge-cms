import { Check, Languages } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { UI_LANGUAGES, useLanguageSetting, useT } from '@/lib/i18n'

/**
 * Picks the admin's display language. Lives in the sidebar footer, above the profile bar — it is a
 * preference for the person, not a property of the site, so it sits with the account rather than the
 * content.
 */
export function LanguageSwitcher() {
  const t = useT()
  const [language, setLanguage] = useLanguageSetting()
  const active = UI_LANGUAGES.find((option) => option.code === language) ?? UI_LANGUAGES[0]!

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton aria-label={t('language.change')}>
              <Languages className="size-4" />
              <span className="truncate">{active.label}</span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              {t('language.label')}
            </DropdownMenuLabel>
            {UI_LANGUAGES.map((option) => (
              <DropdownMenuItem key={option.code} onSelect={() => setLanguage(option.code)}>
                <span className="truncate">{option.label}</span>
                {option.code === language && <Check className="ml-auto size-4" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
