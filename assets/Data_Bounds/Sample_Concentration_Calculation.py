import numpy as np


# Example for calculating what is reported for a bulk sample for any quantity that is a concentration (M)
# bulk_concentration - bulk concentration of the quantity from the spreadsheet
# bulk_concen_units - units of bulk concentration from the spreadsheet, may be 'uM', 'nM', 'M', 'mM', etc
# samp_vol - sample volume requested by the user (in L)
# LOD - Limit of Detection (e.g., the calculated concentration must be > this, otherwise "Tr" is reported)
#
def calculate_sample_concentration_bulk(bulk_concentration, samp_vol, LOD, bulk_concen_units='M'):

    # Convert bulk_concentration to M if necessary:
    if bulk_concen_units == 'uM':
        bulk_concentration = bulk_concentration*1e-6
    elif bulk_concen_units == 'mM':
        bulk_concentration = bulk_concentration*1e-3
    elif bulk_concen_units == 'nM':
        bulk_concentration = bulk_concentration*1e-9

    # Calculate the concentration factor
    Concen_factor = samp_vol/0.001 # concentrated into 1 mL = 0.001 L

    # Multiply concentration by the concentration factor
    concen_in_samp = bulk_concentration*Concen_factor

    # Check if concentration meets limits of detection
    if concen_in_samp < LOD:
        report = 'Tr'
    else:
        report = concen_in_samp

    return report

# Example for calculating what is reported for any size bucket or addition of size buckets for
# any quantity that is a concentration (M)
# particle_size - a list of the particle size for every size bucket requested in the sample
# N_particles - a list of the number of particles in every size bucket requested (comes from FACS sorting)
# particle_concen - a list of the concentration of the quantity for each size bucket (from the spreadsheet)
# inj_vol - injectin volume from the spreadsheet
# LOD - Limit of Detection (e.g., the calculated concentration must be > this, otherwise "Tr" is reported)
#
def calculate_sample_concentration_particles(particle_size, N_particles, particle_concen, inj_vol, LOD, concen_units):

    # Convert concentratiosn to M, if necessary:
    if type(particle_concen) == list:
        particle_concen = np.array(particle_concen)

    if concen_units == 'uM':
        particle_concen = particle_concen*1e-6
    elif concen_units == 'mM':
        particle_concen = particle_concen*1e-3
    elif concen_units == 'nM':
        particle_concen = particle_concen*1e-9

    # For each size bucket, calculate the volume and mols in the sample
    mols_tot = 0
    for bucket in range(len(particle_size)):
        # Assuming the particle_size is the diameter of a particle in um
        radius_m = (particle_size[bucket]/2)*1e-6

        # Get the volume in L
        vol_one_particle = ((4/3)*np.pi*(radius_m)**3)*1000 

        # Multiple by N_particles in that bucket to get total volume in particles
        vol_in_samp = vol_one_particle*N_particles[bucket]

        # Multiply by concentration of that bucket to get mols in sample
        mols_in_samp = vol_in_samp*particle_concen[bucket]

        # add to total
        mols_tot = mols_tot + mols_in_samp

    # Divide total mols by injection volume to get concentration in samp
    final_concen = mols_tot/inj_vol

    if final_concen >= LOD:
        report = final_concen

    else:
        report = 'Tr' 

    return report