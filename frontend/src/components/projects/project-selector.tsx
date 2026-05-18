import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { ProjectDetail } from "@/types/domain"

type ProjectSelectorProps = {
  projects: ProjectDetail[]
  value: string | null
  disabled?: boolean
  onValueChange: (projectSlug: string) => void
}

export function ProjectSelector({
  projects,
  value,
  disabled = false,
  onValueChange,
}: ProjectSelectorProps) {
  return (
    <Select
      value={value ?? undefined}
      disabled={disabled}
      onValueChange={onValueChange}
    >
      <SelectTrigger className="w-full sm:w-72">
        <SelectValue placeholder="Select workspace" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {projects.map((project) => (
            <SelectItem key={project.slug} value={project.slug}>
              {project.name}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
